const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const ytDlp = require('yt-dlp-exec');
const ffmpeg = require('ffmpeg-static');
const os = require('os');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

const TMP_DIR = path.join(__dirname, 'tmp');
const ensureDir = (dir) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
};
ensureDir(TMP_DIR);

// Cleanup job: delete files older than 1 hour to prevent disk space issues on cloud
setInterval(() => {
  fs.readdir(TMP_DIR, (err, files) => {
    if (err) return;
    const now = Date.now();
    files.forEach(file => {
      const filePath = path.join(TMP_DIR, file);
      fs.stat(filePath, (err, stats) => {
        if (err) return;
        if (now - stats.mtimeMs > 3600000) { // 1 hour
          fs.unlink(filePath, () => {});
        }
      });
    });
  });
}, 3600000);

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

app.post('/api/download', async (req, res) => {
  const { urls, format } = req.body;
  
  if (!urls || !Array.isArray(urls)) {
    return res.status(400).json({ error: 'Please provide an array of URLs' });
  }

  const expandedTasks = [];

  for (const url of urls) {
    if (url.includes('list=')) {
      try {
        console.log(`Expanding playlist: ${url}`);
        const info = await ytDlp(url, { dumpSingleJson: true, flatPlaylist: true, noWarnings: true, extractorArgs: 'youtube:player_client=android' });
        if (info && info.entries && info.entries.length > 0) {
          for (const entry of info.entries) {
            expandedTasks.push({
              taskId: Math.random().toString(36).substring(7),
              url: entry.url || `https://www.youtube.com/watch?v=${entry.id}`,
              title: entry.title || 'Video',
              status: 'pending'
            });
          }
        } else {
          expandedTasks.push({ taskId: Math.random().toString(36).substring(7), url, title: 'Video', status: 'pending' });
        }
      } catch (err) {
        console.error('Error expanding playlist:', err.message);
        expandedTasks.push({ taskId: Math.random().toString(36).substring(7), url, title: 'Video', status: 'pending' });
      }
    } else {
      expandedTasks.push({ taskId: Math.random().toString(36).substring(7), url, title: 'Video', status: 'pending' });
    }
  }

  res.json({ message: 'Downloads started', tasks: expandedTasks });

  // Concurrency Limiter
  const MAX_CONCURRENT = 5;
  let running = 0;
  let queue = [...expandedTasks];

  const startDownload = async (task) => {
    io.emit('progress', { taskId: task.taskId, percent: 0, status: 'starting' });
    
    // Clean taskId to ensure it's a valid filename prefix
    const safeTaskId = task.taskId.replace(/[^a-z0-9]/gi, '');
    
    const options = {
      output: path.join(TMP_DIR, `${safeTaskId}_%(title)s.%(ext)s`),
      newline: true,
      noWarnings: true,
      extractorArgs: 'youtube:player_client=android',
      restrictFilenames: true, // To ensure safe URLs
      forceIpv4: true // Often helps bypass datacenter IP blocks
    };

    // Use local ffmpeg-static ONLY if not running on Render (Render has system ffmpeg)
    if (!process.env.RENDER) {
      options.ffmpegLocation = ffmpeg;
    }

    if (format === 'mp3') {
      options.extractAudio = true;
      options.audioFormat = 'mp3';
      options.audioQuality = 0;
    } else {
      options.format = 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best';
      options.mergeOutputFormat = 'mp4';
    }

    try {
      const downloadProcess = ytDlp.exec(task.url, options);

      if (downloadProcess.stdout) {
        downloadProcess.stdout.on('data', (data) => {
          const text = data.toString();
          const progressMatch = text.match(/\[download\]\s+([\d\.]+)%/);
          if (progressMatch) {
            const percent = parseFloat(progressMatch[1]);
            io.emit('progress', { taskId: task.taskId, percent, status: 'downloading' });
          }
        });
      }

      await downloadProcess;
      console.log(`[${task.taskId}] process completed`);
      
      // Find the generated file
      const files = fs.readdirSync(TMP_DIR);
      const downloadedFile = files.find(f => f.startsWith(`${safeTaskId}_`));
      
      if (downloadedFile) {
        io.emit('progress', { 
          taskId: task.taskId, 
          percent: 100, 
          status: 'completed',
          downloadUrl: `/api/file/${encodeURIComponent(downloadedFile)}`
        });
      } else {
        throw new Error('File not found after download');
      }

    } catch (err) {
      const detailedError = err.stderr ? err.stderr.toString() : err.message;
      console.error(`[${task.taskId}] process failed:\n${detailedError}`);
      io.emit('progress', { taskId: task.taskId, percent: 0, status: 'error', error: 'Download failed' });
    }
  };

  const processNext = () => {
    if (queue.length === 0) return;
    while (running < MAX_CONCURRENT && queue.length > 0) {
      const task = queue.shift();
      running++;
      startDownload(task).finally(() => {
        running--;
        processNext();
      });
    }
  };

  processNext();
});

// Endpoint to serve the downloaded file
app.get('/api/file/:filename', (req, res) => {
  const filename = req.params.filename;
  if (filename.includes('/') || filename.includes('..')) {
    return res.status(400).send('Invalid filename');
  }
  
  const filePath = path.join(TMP_DIR, filename);
  
  if (fs.existsSync(filePath)) {
    // We send the file. We could delete it immediately after sending, 
    // but the user might cancel and retry. The 1-hour cron will clean it.
    res.download(filePath, (err) => {
      if (err) {
        console.error('Error sending file:', err);
      }
    });
  } else {
    res.status(404).send('File not found or expired');
  }
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`Backend server running on port ${PORT}`);
});

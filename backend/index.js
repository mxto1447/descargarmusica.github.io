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

const ensureDir = (dir) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
};

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

app.post('/api/download', async (req, res) => {
  const { urls, format, downloadPath } = req.body;
  
  if (!urls || !Array.isArray(urls)) {
    return res.status(400).json({ error: 'Please provide an array of URLs' });
  }

  const finalPath = downloadPath || path.join(os.homedir(), 'Desktop', 'Descargas_YT');
  try {
    ensureDir(finalPath);
  } catch (err) {
    return res.status(500).json({ error: 'Could not create download directory' });
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

  res.json({ message: 'Downloads started', tasks: expandedTasks, downloadPath: finalPath });

  // Concurrency Limiter
  const MAX_CONCURRENT = 5;
  let running = 0;
  let queue = [...expandedTasks];

  const startDownload = async (task) => {
    io.emit('progress', { taskId: task.taskId, percent: 0, status: 'starting' });
    
    const options = {
      output: path.join(finalPath, '%(title)s.%(ext)s'),
      newline: true,
      noWarnings: true,
      ffmpegLocation: ffmpeg,
      extractorArgs: 'youtube:player_client=android'
    };

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
      io.emit('progress', { taskId: task.taskId, percent: 100, status: 'completed' });
    } catch (err) {
      console.error(`[${task.taskId}] process failed:`, err.message);
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

const PORT = 4000;
server.listen(PORT, () => {
  console.log(`Backend server running on http://localhost:${PORT}`);
});

import { useState, useEffect } from 'react';
import io from 'socket.io-client';
import { Folder, Link2, Play, Music, Zap } from 'lucide-react';
import './App.css';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:4000';
const socket = io(API_URL);

function App() {
  const [urls, setUrls] = useState('');
  const [format, setFormat] = useState('mp4');
  const [tasks, setTasks] = useState({});
  const [isDownloading, setIsDownloading] = useState(false);

  useEffect(() => {
    socket.on('progress', (data) => {
      setTasks((prev) => {
        const task = prev[data.taskId];
        if (task && task.status !== 'completed' && data.status === 'completed' && data.downloadUrl) {
          const a = document.createElement('a');
          a.href = `${API_URL}${data.downloadUrl}`;
          a.download = '';
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
        }

        return {
          ...prev,
          [data.taskId]: {
            ...prev[data.taskId],
            percent: data.percent,
            status: data.status,
            error: data.error,
            downloadUrl: data.downloadUrl
          }
        };
      });
    });

    return () => {
      socket.off('progress');
    };
  }, []);

  const getUrlList = () => urls.split('\n').map(u => u.trim()).filter(u => u.length > 0);

  const handleDownload = async () => {
    const list = getUrlList();
    if (list.length === 0) return;

    setIsDownloading(true);
    setTasks({});

    try {
      const response = await fetch(`${API_URL}/api/download`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ urls: list, format }),
      });

      const data = await response.json();

      if (data.tasks) {
        const initialTasks = {};
        data.tasks.forEach(task => {
          initialTasks[task.taskId] = { 
            title: task.title, 
            url: task.url, 
            percent: 0, 
            status: task.status 
          };
        });
        setTasks(initialTasks);
      }

    } catch (error) {
      console.error('Error starting download:', error);
      setIsDownloading(false);
    }
    
    // We don't set isDownloading(false) here immediately because 
    // we want to lock the UI while the queue is running, or we can unlock it to queue more.
    // Let's unlock it so users can paste more while it runs!
    setIsDownloading(false);
    setUrls('');
  };

  return (
    <div className="app-wrapper animate-slide-up">
      <div className="header-cyber">
        <h1>
          <Zap size={48} color="#ef4444" />
          NEXUS DOWNLOADER
        </h1>
        <p>Direct Playlist Extraction // Maximum Velocity</p>
      </div>

      <div className="panel controls-panel">

        <div className="input-group">
          <label><Link2 size={18} /> Media Links & Playlists</label>
          <textarea 
            className="input-cyber url-input"
            value={urls}
            onChange={(e) => setUrls(e.target.value)}
            placeholder="Paste direct URLs or entire YouTube Playlists here..."
          />
        </div>

        <div className="actions-row">
          <select 
            className="input-cyber select-cyber"
            value={format}
            onChange={(e) => setFormat(e.target.value)}
          >
            <option value="mp4">HQ Video (MP4)</option>
            <option value="mp3">HQ Audio (MP3)</option>
          </select>

          <button 
            className="btn-cyber btn-download"
            onClick={handleDownload}
            disabled={isDownloading || urls.trim() === ''}
          >
            {format === 'mp4' ? <Play size={20} /> : <Music size={20} />}
            INITIALIZE DOWNLOAD
          </button>
        </div>
      </div>

      {Object.keys(tasks).length > 0 && (
        <div className="tasks-grid animate-slide-up">
          {Object.entries(tasks).map(([taskId, task]) => (
            <div key={taskId} className="panel task-card">
              <div className="task-header">
                <p className="task-title" title={task.title || task.url}>
                  {task.title || task.url}
                </p>
                <span className={`status-badge status-${task.status}`}>
                  {task.status === 'downloading' ? `${task.percent.toFixed(1)}%` : task.status}
                </span>
              </div>
              
              <div className="progress-track">
                <div 
                  className="progress-fill" 
                  style={{ width: `${task.percent}%` }}
                ></div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default App;

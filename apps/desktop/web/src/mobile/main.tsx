import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { initPhone } from './boot.js';
import './mobile.css';

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
initPhone();
createRoot(document.getElementById('root')!).render(<App />);

import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { initApp } from './boot.js';
import './styles.css';

initApp();
createRoot(document.getElementById('root')!).render(<App />);

import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { Setup } from './Setup.js';
import { initApp } from './boot.js';
import './styles.css';

const setup = new URLSearchParams(window.location.search).has('setup');
if (!setup) initApp();
createRoot(document.getElementById('root')!).render(setup ? <Setup /> : <App />);

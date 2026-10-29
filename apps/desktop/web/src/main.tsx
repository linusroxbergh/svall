import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { Setup } from './Setup.js';
import { initApp } from './boot.js';
import { setAppStore } from './hooks.js';
import { createAppStore } from './store/index.js';
import './styles.css';

const setup = new URLSearchParams(window.location.search).has('setup');
// the setup page has no fleet, only the feedback form's draft
if (setup) setAppStore(createAppStore()); else initApp();
createRoot(document.getElementById('root')!).render(setup ? <Setup /> : <App />);

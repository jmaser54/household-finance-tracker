import { render } from 'preact';
import { App } from './ui/App';
import { installGlobalGuards } from './privacy/guards';
import './ui/styles.css';

installGlobalGuards();

const root = document.getElementById('app');
if (root) render(<App />, root);

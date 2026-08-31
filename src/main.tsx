import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { DeckApp } from './deck/DeckApp';
import { parseDeckMode } from './deck/protocol';
import './styles.css';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('Root element #root not found');

const deckMode = parseDeckMode(location.search);
if (deckMode) document.documentElement.classList.add('deck-mode');

createRoot(rootEl).render(<StrictMode>{deckMode ? <DeckApp /> : <App />}</StrictMode>);

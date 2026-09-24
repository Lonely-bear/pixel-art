import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { EditorProvider } from './editor-context.js';
import { I18nProvider } from './i18n.js';
import { App } from './App.js';
import './styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('#root is missing from index.html');

createRoot(container).render(
  <StrictMode>
    <I18nProvider>
      <EditorProvider>
        <App />
      </EditorProvider>
    </I18nProvider>
  </StrictMode>,
);

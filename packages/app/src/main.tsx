import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { EditorProvider } from './editor-context.js';
import { I18nProvider } from './i18n.js';
import { PrefsProvider, applyPrefs, readPrefs, resolveTheme } from './prefs.js';
import { App } from './App.js';
import './styles.css';

// Before the first render, so the body never paints one frame of defaults.
{
  const prefs = readPrefs();
  applyPrefs(prefs, resolveTheme(prefs.themeMode));
}

const container = document.getElementById('root');
if (!container) throw new Error('#root is missing from index.html');

createRoot(container).render(
  <StrictMode>
    <PrefsProvider>
      <I18nProvider>
        <EditorProvider>
          <App />
        </EditorProvider>
      </I18nProvider>
    </PrefsProvider>
  </StrictMode>,
);

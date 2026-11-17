// How the app looks and feels, so it suits everyone: children, adults and
// older people. Kept on this device only.
//
//   easy     - Easy mode: big buttons, plain words, fewer choices.
//   text     - 'normal' | 'large' | 'xlarge': the size of menus, lists and bars.
//   labels   - show the name of each button under its picture in toolbars.
//   contrast - stronger colours and outlines.

const KEY = 'plain-office:settings';
const DEFAULTS = { easy: false, text: 'normal', labels: false, contrast: false };
const ZOOM = { normal: 1, large: 1.15, xlarge: 1.3 };

let stored = null;
try { stored = JSON.parse(localStorage.getItem(KEY)); } catch { /* private mode */ }

export const settings = { ...DEFAULTS, ...(stored || {}) };
if (!(settings.text in ZOOM)) settings.text = 'normal';

// Nothing saved yet: the app has not asked how it should look.
export const firstRun = !stored;

export function applySettings() {
  const root = document.documentElement;
  root.classList.toggle('easy', !!settings.easy);
  root.classList.toggle('labels', !!settings.labels);
  root.classList.toggle('contrast', !!settings.contrast);
  root.classList.toggle('big-text', settings.text !== 'normal');
  root.style.setProperty('--ui-zoom', ZOOM[settings.text]);
}

export function saveSettings(changes = {}) {
  Object.assign(settings, changes);
  try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch { /* private mode */ }
  applySettings();
}

// Easy mode turns its helpers on together and off together; each can still be
// changed on its own afterwards.
export function setEasy(on) {
  saveSettings(on
    ? { easy: true, labels: true, text: settings.text === 'normal' ? 'large' : settings.text }
    : { easy: false, labels: false, text: 'normal' });
}

applySettings();

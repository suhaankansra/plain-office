// Android: help make Plain Office the app that opens documents.
//
// Android doesn't let apps make themselves the default, so this walks the
// person through it: we open a small sample file, Android shows its
// "Open with" list, and they pick Plain Office and tap "Always". If another
// app (say WPS Office) is already the default, Android only lets that app's
// own settings page clear it, so we take them there first.
import { Capacitor, registerPlugin } from '@capacitor/core';
import { h, actionSheet, customDialog, toast } from './ui.js';

const DefaultApp = registerPlugin('DefaultApp');

export const SAMPLE_NAME = 'plain-office-default-check';
const ASKED_KEY = 'plainOffice.defaultAppAsked';

const TYPES = [
  { key: 'pdf', badge: 'pdf', label: 'PDFs', ext: 'pdf', mime: 'application/pdf' },
  { key: 'docx', badge: 'doc', label: 'Word documents', ext: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  { key: 'xlsx', badge: 'sheet', label: 'Excel spreadsheets', ext: 'xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  { key: 'pptx', badge: 'slides', label: 'PowerPoint slides', ext: 'pptx', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' },
];
const byKey = Object.fromEntries(TYPES.map((t) => [t.key, t]));
const NOTE = 'This is a sample file that Plain Office used to set itself as your default app. You can close it.';

export const supported = () => Capacitor.getPlatform() === 'android';

// What we're waiting on while the person is in Android's list or another app's settings.
let pending = null;

async function statuses() {
  const { types } = await DefaultApp.status({ types: TYPES.map(({ key, ext, mime }) => ({ key, ext, mime })) });
  return Object.fromEntries(types.map((s) => [s.key, s]));
}

// A tiny real file of each type, so it opens properly in whichever app is picked.
async function sample(key) {
  if (key === 'pdf') {
    const { PDFDocument, StandardFonts } = await import('pdf-lib');
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    pdf.addPage([420, 200]).drawText(NOTE, { x: 24, y: 150, size: 12, font, maxWidth: 372, lineHeight: 16 });
    return pdf.saveAsBase64();
  }
  if (key === 'docx') {
    const { Document, Packer, Paragraph } = await import('docx');
    const blob = await Packer.toBlob(new Document({ sections: [{ children: [new Paragraph(NOTE)] }] }));
    return blobToBase64(blob);
  }
  if (key === 'xlsx') {
    const XLSX = await import('xlsx');
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([[NOTE]]), 'Sheet1');
    return XLSX.write(book, { type: 'base64', bookType: 'xlsx' });
  }
  const PptxGenJS = (await import('pptxgenjs')).default;
  const pptx = new PptxGenJS();
  pptx.addSlide().addText(NOTE, { x: 0.5, y: 2, w: 9, h: 1.5, fontSize: 20 });
  return pptx.write({ outputType: 'base64' });
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function steps(title, lines, ok) {
  return customDialog(title, (dialog, close) => {
    dialog.append(
      h('ol', { class: 'steps' }, lines.map((line) => h('li', {}, line))),
      h('div', { class: 'row' },
        h('button', { class: 'btn', onClick: () => close(false) }, 'Cancel'),
        h('button', { class: 'btn primary', onClick: () => close(true) }, ok)));
  });
}

async function pickInAndroidList(type) {
  if (!await steps(`Open ${type.label} with Plain Office`, [
    'Android will ask which app to use.',
    'Choose Plain Office.',
    'Tap “Always”.',
  ], 'Continue')) return;
  try {
    const data = await sample(type.key);
    pending = { key: type.key, step: 'choose' };
    await DefaultApp.choose({ mime: type.mime, ext: type.ext, data });
  } catch (err) {
    pending = null;
    toast(err?.message || 'Could not open the list of apps');
  }
}

async function clearOtherApp(type, status) {
  if (!await steps(`${status.app} opens ${type.label} now`, [
    `Android will open the settings for ${status.app}.`,
    'Tap “Open by default” (it may be called “Set as default”).',
    'Tap “Clear defaults” (or “Clear default preferences”).',
    'Come back here with the back button.',
  ], 'Open settings')) return;
  try {
    pending = { key: type.key, step: 'settings' };
    await DefaultApp.openAppSettings({ package: status.package });
  } catch {
    pending = null;
    toast(`Could not open the settings for ${status.app}`);
  }
}

async function setUp(key, status) {
  const type = byKey[key];
  if (status.state === 'ours') return toast(`Plain Office already opens ${type.label}`);
  if (status.state === 'other') return clearOtherApp(type, status);
  return pickInAndroidList(type);
}

// The list of file types and which app opens each one now.
export async function showDefaultApps() {
  if (!supported()) return;
  let current;
  try {
    current = await statuses();
  } catch {
    return toast('Could not check your default apps');
  }
  const hint = (s) => (s.state === 'ours' ? '✓ Plain Office' : s.state === 'other' ? s.app : 'Not set');
  const allOurs = TYPES.every((t) => current[t.key].state === 'ours');
  const key = await actionSheet('Open documents with Plain Office', [
    { node: h('p', { class: 'sheet-note' }, allOurs
      ? 'You’re all set: these files open in Plain Office.'
      : 'Choose a file type to make Plain Office open it.') },
    ...TYPES.map((t) => ({ badge: t.badge, label: t.label, hint: hint(current[t.key]), value: t.key })),
  ]);
  if (key) setUp(key, current[key]);
}

// When the person comes back from Android's list or another app's settings.
// (Both the app resuming and our sample file arriving call this; only the first one acts.)
async function resumed() {
  if (!pending) return;
  const { key, step } = pending;
  pending = null;
  const type = byKey[key];
  let status;
  try {
    status = (await statuses())[key];
  } catch {
    return;
  }
  if (status.state === 'ours') return toast(`Plain Office now opens ${type.label}`);
  if (status.state === 'other') {
    return toast(step === 'settings' ? `${status.app} still opens ${type.label}` : `${status.app} was chosen for ${type.label}`);
  }
  if (step === 'settings') return pickInAndroidList(type); // cleared: on to Android's list
  toast('Not set. Choose Plain Office, then tap “Always”');
}

// Our own sample file came back to us: the person picked Plain Office.
// Returns true when the opened file was that sample (so it isn't added to the list).
export function handleSample(name) {
  if (!name?.startsWith(SAMPLE_NAME)) return false;
  setTimeout(resumed, 300); // let Android record the choice first
  return true;
}

// Ask once, on first launch, if Plain Office doesn't open documents yet.
export async function maybeAsk() {
  if (!supported()) return;
  try {
    if (localStorage.getItem(ASKED_KEY)) return;
    localStorage.setItem(ASKED_KEY, '1');
  } catch {
    return;
  }
  let current;
  try {
    current = await statuses();
  } catch {
    return;
  }
  if (TYPES.every((t) => current[t.key].state === 'ours')) return;
  const others = [...new Set(TYPES.map((t) => current[t.key]).filter((s) => s.state === 'other').map((s) => s.app))];
  const yes = await customDialog('Open documents with Plain Office?', (dialog, close) => {
    dialog.append(
      h('p', { class: 'lead' }, 'Make Plain Office the app that opens PDFs, Word, Excel and PowerPoint files on this phone.'),
      others.length ? h('p', {}, `Right now they open with ${others.join(', ')}.`) : null,
      h('div', { class: 'row' },
        h('button', { class: 'btn', onClick: () => close(false) }, 'Not now'),
        h('button', { class: 'btn primary', onClick: () => close(true) }, 'Set up')));
  });
  if (yes) showDefaultApps();
}

if (supported()) {
  import('@capacitor/app').then(({ App }) => App.addListener('resume', () => setTimeout(resumed, 300)));
}

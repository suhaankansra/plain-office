// What each platform offers.
import { Capacitor } from '@capacitor/core';

export const platform = Capacitor.getPlatform();

// The computer and Linux phone apps tell the page which one they are before it
// loads: 'macos' (macos/), 'windows' (windows/) or 'linux' (linux/).
export const host = window.plainOfficeHost?.os || (platform === 'web' ? 'web' : platform);
export const isDesktopApp = host === 'macos' || host === 'windows' || host === 'linux';

// Apple's Pages, Numbers and Keynote files: on Android and Linux they open
// read-only (to look at, not edit), and Plain Office doesn't make .pages files there.
export const IWORK_EXTS = ['pages', 'numbers', 'key'];
export const iworkReadOnly = platform === 'android' || host === 'linux';
export const canMakePages = !iworkReadOnly;

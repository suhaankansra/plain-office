// What each platform offers.
import { Capacitor } from '@capacitor/core';

export const platform = Capacitor.getPlatform();

// Apple's Pages, Numbers and Keynote files: on Android they open read-only
// (to look at, not edit), and Plain Office doesn't make .pages files there.
export const IWORK_EXTS = ['pages', 'numbers', 'key'];
export const iworkReadOnly = platform === 'android';
export const canMakePages = !iworkReadOnly;

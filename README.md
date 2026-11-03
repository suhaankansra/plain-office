# Plain Office

A free, open-source office suite for **iPhone and Android** that respects your privacy.
Write documents, build spreadsheets, make presentations and edit PDFs — all on your phone,
with no account, no ads, no tracking and no internet connection required.

## Why

Many popular mobile office apps collect far more data than they need. Plain Office takes the
opposite approach:

- **Your files never leave your phone.** Everything is stored on the device.
- **No network access.** The app's Content Security Policy blocks every outgoing connection,
  so even a bug or a malicious file can't send your data anywhere.
- **No accounts, analytics, ads or trackers.** None are included.
- **All code is open.** Anyone can read it, check it and build it themselves.

## Features

| App | What you can do | Opens | Saves as |
| --- | --- | --- | --- |
| **Docs** | Headings, bold/italic/underline, colors, highlight, text size, alignment, lists, indents, tables, pictures, links, find & replace, word count | .docx, .txt, .md, .html | .docx, .pdf, .txt, .html |
| **Sheets** | 40+ formulas (SUM, AVERAGE, IF, VLOOKUP, SUMIF, COUNTIF, ROUND…), tap-to-insert cell references, AutoSum, number/money/percent formats, bold, colors, sort, insert/delete rows & columns, fill down/right, copy/paste, multiple sheets | .xlsx, .xls, .csv, .ods | .xlsx, .csv, .pdf |
| **Slides** | Layouts, themes, text boxes, pictures, shapes, drag to move, resize, reorder slides, full-screen presenting with swipe | .pptx | .pptx, .pdf |
| **PDF** | Add text (fill in forms), draw with a pen, highlight, white-out, sign with a saved signature, insert pictures, rotate/delete/reorder pages, add blank pages, combine PDFs, turn photos into a PDF, open password-protected PDFs | .pdf, .jpg, .png | .pdf |

Also: undo/redo everywhere, light and dark mode, search and filters on the home screen,
"Open with Plain Office" from other apps, and sharing to Files, Google Drive, email and so on
through the phone's own share sheet.

## Building it yourself

You need [Node.js](https://nodejs.org) 20 or newer.

```bash
npm install
npm run dev        # try it in a desktop browser at http://localhost:5173
```

### iPhone / iPad

Needs a Mac with Xcode and CocoaPods.

```bash
npm run ios        # builds the web app, syncs it, and opens Xcode
```

In Xcode, pick your team under *Signing & Capabilities*, choose a device or simulator, and press Run.

### Android

Needs Android Studio (or the Android SDK plus JDK 21).

```bash
npm run android    # builds the web app, syncs it, and opens Android Studio
```

Or build an APK from the command line:

```bash
npm run sync && cd android && ./gradlew assembleDebug
# APK: android/app/build/outputs/apk/debug/app-debug.apk
```

### Building on a laptop with 8 GB of RAM

The project is set up to stay light:

- Gradle is capped at 1.5 GB, with no background daemon and at most 2 workers (`android/gradle.properties`).
- For iOS, close the Simulator when you don't need it and limit Xcode's parallel jobs:
  `xcodebuild -jobs 2 ...`, or for Xcode itself run
  `defaults write com.apple.dt.Xcode IDEBuildOperationMaxNumberOfConcurrentCompileTasks 2`.
- Build one platform at a time, and close Android Studio while Xcode is building (and the other way round).

## How it's built

Plain Office is a web app wrapped as a native app with [Capacitor](https://capacitorjs.com).
There is no framework: plain JavaScript modules that are easy to read and change.

```
src/
  main.js            home screen, opening and creating files
  ui.js              small UI helpers (dialogs, menus, icons)
  store.js           on-device storage (IndexedDB)
  files.js           file picker, "Open with", save/share
  styles.css         all styling (light + dark)
  apps/
    docs.js          word processor
    docx-export.js   HTML → Word converter
    sheets.js        spreadsheet
    formula.js       formula engine
    slides.js        presentations
    pdf.js           PDF editor
    render-pdf.js    "Export as PDF" for docs, sheets and slides
    shell.js         shared editor top bar
```

It uses these open-source libraries, all bundled in the app (nothing loads from the internet):
[mammoth](https://github.com/mwilliamson/mammoth.js) (read .docx),
[docx](https://github.com/dolanmiu/docx) (write .docx),
[SheetJS](https://sheetjs.com) (spreadsheets),
[PptxGenJS](https://github.com/gitbrent/PptxGenJS) and [JSZip](https://github.com/Stuk/jszip) (presentations),
[PDF.js](https://github.com/mozilla/pdf.js) (show PDFs),
[pdf-lib](https://github.com/Hopding/pdf-lib) (edit PDFs),
[jsPDF](https://github.com/parallax/jsPDF) and [html2canvas](https://github.com/niklasvh/html2canvas) (export to PDF).

## Known limitations

These are good first things to work on:

- Old binary formats (.doc, .ppt) aren't supported. .docx, .xlsx and .pptx are.
- Complex Word layouts (columns, text boxes, headers/footers, comments, tracked changes) are simplified on import.
- Spreadsheet cell styles (bold, colors) are kept in the app but not yet written to .xlsx. Charts aren't supported yet.
- PowerPoint import keeps text, pictures, simple shapes and positions, but not animations, charts or master-slide designs.
- The PDF editor adds content on top of a page. It can't change the PDF's existing text, so use white-out and then type over it.
- Exporting a password-protected PDF saves its pages as images.
- "Open with" from other apps and the share sheet have been set up but should be tested on real devices.

## Contributing

Issues and pull requests are welcome. Please keep the two core promises: **no network access**
and **no tracking of any kind**.

## License

[MIT](LICENSE)

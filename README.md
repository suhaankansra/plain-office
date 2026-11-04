# Plain Office

A free, open-source office suite for **iPhone, Android, Linux phones and Chromebooks** that respects your privacy.
Write documents, build spreadsheets, make presentations, edit and scan PDFs — all on your
phone, with no account, no ads, no tracking and no internet connection required.

## Why

Many popular mobile office apps collect far more data than they need. Plain Office takes the
opposite approach:

- **Your files never leave your phone.** Everything is stored on the device.
- **No network access.** The app's Content Security Policy blocks every outgoing connection,
  so even a bug or a malicious file can't send your data anywhere.
- **No accounts, analytics, ads or trackers.** None are included.
- **All code is open.** Anyone can read it, check it and build it themselves.

## Features

| App | What you can do |
| --- | --- |
| **Docs** | Headings, bold/italic/underline, colors, highlight, text size, alignment, lists, indents, tables, pictures, links, find & replace, word count, **Text from a photo** (OCR) |
| **Sheets** | 40+ formulas (SUM, AVERAGE, IF, VLOOKUP, SUMIF, COUNTIF, ROUND…), tap-to-insert cell references, AutoSum, number/money/percent formats, bold, colors, sort, insert/delete rows & columns, fill down/right, copy/paste, multiple sheets |
| **Slides** | Layouts, themes, text boxes, pictures, shapes, drag to move, resize, reorder slides, full-screen presenting with swipe |
| **PDF** | Add text (fill in forms), draw, highlight, white-out, sign with a saved signature, insert pictures, rotate/delete/reorder pages, add blank pages, combine PDFs, photos to PDF, password-protected PDFs, **Recognize text** (OCR) so scanned PDFs can be searched and copied |
| **Converters** | **PDF to Word** (.docx) and **PDF to Pages** (.pages), or edit a PDF's text as a document. Headings, paragraphs, lists, bold/italic and pictures are rebuilt from the PDF; scanned pages are read with OCR. |
| **Scanner** | Take or pick photos of paper; the page edges are found automatically (drag the corners to adjust), the perspective is straightened, and you choose Original, Enhanced, Grayscale or Black & white. Pages are saved as a PDF with searchable text. |

Also: undo/redo everywhere, light and dark mode, search and filters on the home screen,
"Open with Plain Office" from other apps, and sharing to Files, Google Drive, email and so on
through the phone's own share sheet.

### File formats

| | Opens | Saves |
| --- | --- | --- |
| **Documents** | Word (.docx, .docm, .dotx, .doc), Rich Text (.rtf), OpenDocument (.odt, .ott, .fodt), Apple Pages (.pages), AbiWord (.abw, .zabw), plain text and Markdown, web pages (.html, .xhtml) | .docx, .pages, .pdf, .rtf, .txt, .md, .html |
| **E-books** | EPUB, Kindle/Mobipocket (.mobi, .azw, .azw3, .prc — without DRM), FictionBook (.fb2) | |
| **Email & web archives** | .eml, Outlook .msg, saved web pages (.mht, .mhtml) — with sender, date, subject, inline pictures and the list of attachments | |
| **Spreadsheets** | Excel (.xlsx, .xlsm, .xlsb, .xls), Apple Numbers (.numbers), OpenDocument (.ods, .fods), CSV/TSV, dBASE (.dbf), Lotus 1-2-3, Quattro Pro, SYLK, DIF, Excel 2003 XML, JSON lists | .xlsx, .ods, .xls, .csv, .pdf |
| **Contacts & calendars** | vCard (.vcf) and iCalendar (.ics) open as tidy tables | |
| **Presentations** | PowerPoint (.pptx, .pptm, .ppsx, .potx, .ppt), Apple Keynote (.key), OpenDocument (.odp) | .pptx, .pdf |
| **PDF & pictures** | PDF, JPEG, PNG, HEIC, WebP, GIF, BMP, TIFF, AVIF, JPEG XL, SVG, comic books (.cbz) | .pdf, and PDF → .docx / .pages |
| **Other** | Jupyter notebooks (.ipynb), XPS/OpenXPS print files, code and config files (.json, .xml, .yaml, .py, .js…), subtitles (.srt, .vtt), **.zip** (pick the file inside) | |

Files with no extension are recognised by their contents. For anything else, Plain Office
offers to show whatever readable text is inside the file.

## Install

Download the latest files from the [Releases page](https://github.com/suhaankansra/plain-office/releases).

- **Android:** open `PlainOffice-x.y.z.apk` on your phone and allow installing from this source when asked.
- **iPhone / iPad:** the `.ipa` is unsigned, because apps outside the App Store must be signed with
  your own Apple ID. Install it with [AltStore](https://altstore.io) or [Sideloadly](https://sideloadly.io).
  With a free Apple ID, the app has to be refreshed every 7 days.
- **Chromebooks (ChromeOS):** open **https://suhaankansra.github.io/plain-office/** in Chrome and choose
  *Install Plain Office* (the install icon in the address bar, or ⋮ → *Cast, save and share* → *Install page as app*).
  It gets its own window and launcher icon, works offline, and appears under *Open with* for documents in
  the Files app. Alternatively install the Android APK (on Chromebooks with Android apps) or the
  `PlainOffice-x.y.z-linux-debian.deb` in ChromeOS's Linux environment (double-click it in Files).
- **Linux phones and computers** (postmarketOS, Mobian, Manjaro ARM, Fedora, Ubuntu… with Phosh,
  GNOME Mobile, Plasma Mobile or any desktop): install the `.flatpak` for your device —
  `aarch64` for phones, `x86_64` for PCs:
  `flatpak install --user PlainOffice-x.y.z-linux-aarch64.flatpak`.
  The Flatpak has no network access at all. Without Flatpak, unpack the `portable.tar.gz` and run
  its `install.sh` (it lists the packages to install first).

## Building it yourself

You need [Node.js](https://nodejs.org) 20 or newer.

```bash
npm install
npm run dev        # try it in a desktop browser at http://localhost:5173
```

`npm run dev` and `npm run build` first copy the OCR engine and its English language data into
`public/ocr` (see `scripts/copy-ocr.mjs`), so text recognition works offline.

### iPhone / iPad

Needs a Mac with Xcode and CocoaPods.

```bash
npm run ios        # builds the web app, syncs it, and opens Xcode
```

In Xcode, pick your team under *Signing & Capabilities*, choose a device or simulator, and press Run.

### Android

Needs Android Studio, or the Android SDK plus **JDK 21** (`brew install openjdk@21` on a Mac).

```bash
npm run android    # builds the web app, syncs it, and opens Android Studio
```

Or build an APK from the command line:

```bash
npm run sync && cd android && ./gradlew assembleDebug
# APK: android/app/build/outputs/apk/debug/app-debug.apk
```

`./gradlew assembleRelease` signs the release APK with the key described in
`~/.android/plain-office-release.properties` (`storeFile`, `storePassword`, `keyAlias`,
`keyPassword`). Without that file the release APK is left unsigned.

### Web app (Chromebooks and desktops)

`npm run build` also writes `dist/sw.js`, a service worker that caches every app file so the installed
web app works offline, and `public/manifest.webmanifest` makes it installable with ChromeOS file handlers.
The **Web app** GitHub Actions workflow publishes `dist` to GitHub Pages on every push to `main`.
Test the production build locally with `npm run build && npx vite preview`.

### Linux

The Linux app (`linux/plain_office.py`) is a small GTK 4 / libadwaita window that shows the web app with
WebKitGTK. It serves the app's files to itself on 127.0.0.1 behind a random secret path, keeps browsing
inside the app, saves exported files to Downloads, and opens files passed to it ("Open with").

```bash
npm run build
PLAIN_OFFICE_WEB=dist python3 linux/plain_office.py      # needs PyGObject, GTK 4, libadwaita, WebKitGTK 6.0
flatpak-builder --user --install build linux/org.plainoffice.PlainOffice.yml
```

The **Linux** GitHub Actions workflow builds a Debian package and runs it on Ubuntu as a smoke test
(including checking that documents survive a restart), builds Flatpaks for aarch64 and x86_64 and a
portable tarball, and attaches them to the release when a `v*` tag is pushed
(or when run by hand with a release tag).

### Building on a laptop with 8 GB of RAM

The project is set up to stay light:

- Gradle is capped at 1.5 GB, with no background daemon and at most 2 workers (`android/gradle.properties`).
- For iOS, close the Simulator when you don't need it and limit Xcode's parallel jobs:
  `xcodebuild -jobs 2 ...`, or for Xcode itself run
  `defaults write com.apple.dt.Xcode IDEBuildOperationMaxNumberOfConcurrentCompileTasks 2`.
- Build one platform at a time, and close Android Studio while Xcode is building (and the other way round).

### Icons and launch screens

The artwork lives in `assets/*.svg` (and `public/icon.svg` for the in-app logo). After changing
it, run `scripts/make-icons.sh` (macOS) to regenerate every iOS and Android size. The Android
adaptive icon is a vector in `android/app/src/main/res/drawable/ic_launcher_foreground.xml`.

## How it's built

Plain Office is a web app wrapped as a native app with [Capacitor](https://capacitorjs.com).
There is no framework: plain JavaScript modules that are easy to read and change.

```
src/
  main.js            home screen, opening and creating files
  ui.js              small UI helpers (dialogs, menus, icons)
  store.js           on-device storage (IndexedDB)
  files.js           file picker, "Open with", type detection, save/share
  ocr.js             on-device text recognition (Tesseract)
  styles.css         all styling (light + dark)
  apps/
    docs.js          word processor
    docx-export.js   HTML → Word converter
    sheets.js        spreadsheet
    formula.js       formula engine
    slides.js        presentations
    pdf.js           PDF editor
    scanner.js       document scanner (edge detection, perspective, filters)
    render-pdf.js    "Export as PDF" for docs, sheets and slides
    shell.js         shared editor top bar
    convert.js       PDF → Word / Pages / document, and document → Pages
    formats/         readers for other formats: iwork, rtf, odf, legacy (.doc/.ppt),
                     epub, ebook (.mobi/.fb2), mail (.eml/.msg/.mht), misc (.ipynb,
                     .abw, .xps, .vcf, .ics, text recovery), pdf-convert (PDF →
                     document), pages-writer (writes .pages)
```

It uses these open-source libraries, all bundled in the app (nothing loads from the internet):
[mammoth](https://github.com/mwilliamson/mammoth.js) (read .docx),
[docx](https://github.com/dolanmiu/docx) (write .docx),
[SheetJS](https://sheetjs.com) (spreadsheets, old Office containers),
[PptxGenJS](https://github.com/gitbrent/PptxGenJS) and [JSZip](https://github.com/Stuk/jszip) (presentations, zips),
[PDF.js](https://github.com/mozilla/pdf.js) (show PDFs),
[pdf-lib](https://github.com/Hopding/pdf-lib) (edit PDFs),
[jsPDF](https://github.com/parallax/jsPDF) and [html2canvas](https://github.com/niklasvh/html2canvas) (export to PDF),
[Tesseract.js](https://github.com/naptha/tesseract.js) (OCR).

## Known limitations

These are good first things to work on:

- **Pages and Keynote** files open with their text (Keynote: slide titles and bullet points); layout,
  pictures and styling are not imported yet. **Numbers** files open with their values; formulas come in as results.
- **Saving as .pages** keeps paragraphs, headings (Title/Heading styles) and lists, but not bold/italic, colours,
  tables or pictures yet. Pages has no public format, so the app fills a blank document made by Pages
  (`public/templates/blank.pages`). Save as .docx when you need full formatting; Pages opens .docx too.
- **PDF conversion** rebuilds the document from where text sits on the page, so multi-column layouts and tables
  come out as plain paragraphs.
- Old **.doc and .ppt** files open as text (with tables for .doc), without formatting.
- **Kindle** books with DRM or the newer "HUFF/CDIC" compression can't be opened.
- **XPS** files open as text only.
- **OCR** reads English. To add a language, put its `*.traineddata.gz` file in `public/ocr` and pass
  its code to `createWorker` in `src/ocr.js`. The OCR engine adds about 9 MB to the app.
- Complex Word layouts (columns, text boxes, headers/footers, comments, tracked changes) are simplified on import.
- Spreadsheet cell styles (bold, colors) are kept in the app but not yet written to .xlsx. Charts aren't
  supported yet. Saving as old-style .xls keeps values only.
- PowerPoint import keeps text, pictures, simple shapes and positions, but not animations, charts or master-slide designs.
- The PDF editor adds content on top of a page. It can't change the PDF's existing text, so use white-out and then type over it.
- Exporting a password-protected PDF saves its pages as images.
- "Open with" from other apps, the share sheet and the camera have been set up but should be tested on real devices.
- On Linux, the scanner and "Text from a photo" pick existing photos (there's no in-app camera), and
  Ubuntu Touch isn't supported yet (it needs its own Click package).

## Contributing

Issues and pull requests are welcome. Please keep the two core promises: **no network access**
and **no tracking of any kind**.

## License

[MIT](LICENSE)

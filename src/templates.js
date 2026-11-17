// Ready-made starting points, so nobody has to face a blank page.
// Each one builds the same data the editors make themselves (see store.js).

const today = () => new Date().toLocaleDateString(undefined, { dateStyle: 'long' });

// A spreadsheet from rows of plain values. The first row is the header.
function table(name, rows, { color = 'blue', widths = {}, checks = [] } = {}) {
  const cells = {};
  rows.forEach((row, r) => row.forEach((v, c) => {
    if (v === '' || v == null) return;
    const ref = `${String.fromCharCode(65 + c)}${r + 1}`;
    cells[ref] = { v: String(v) };
    if (r > 0 && checks.includes(c)) cells[ref].nf = 'check';
  }));
  return { sheets: [{ name, cells, cols: widths, look: { header: true, banded: true, color } }], active: 0 };
}

// A presentation from a theme and slides. Slides use the editor's 960x540 canvas
// and the same theme numbers and colours as slides.js.
const ACCENTS = ['#2b6fdc', '#fca311', '#e8711a', '#1f9d55', '#5fa8ff', '#c2409b'];
let elId = 0;
const el = (props) => ({ id: `t${Date.now().toString(36)}${(elId++).toString(36)}`, ...props });
const words = (x, y, w, hgt, size, html, more = {}) => el({ type: 'text', x, y, w, h: hgt, size, align: 'left', html, ...more });
const list = (items) => `<ul>${items.map((i) => `<li>${i}</li>`).join('')}</ul>`;
const titleSlide = (theme, title, subtitle) => [
  el({ type: 'shape', shape: 'rect', x: 80, y: 290, w: 120, h: 8, fill: ACCENTS[theme] }),
  words(80, 150, 800, 130, 54, title, { bold: true, role: 'title' }),
  words(80, 320, 800, 60, 26, subtitle, { role: 'subtitle' }),
];
const bullets = (title, items) => [
  words(60, 40, 840, 80, 40, title, { bold: true, role: 'title' }),
  words(60, 140, 840, 360, 26, list(items)),
];
const twoColumns = (title, left, leftItems, right, rightItems) => [
  words(60, 40, 840, 80, 40, title, { bold: true, role: 'title' }),
  words(60, 140, 405, 50, 28, `<b>${left}</b>`),
  words(60, 195, 405, 310, 24, list(leftItems)),
  words(495, 140, 405, 50, 28, `<b>${right}</b>`),
  words(495, 195, 405, 310, 24, list(rightItems)),
];
const section = (theme, title) => [
  el({ type: 'shape', shape: 'rect', x: 80, y: 310, w: 120, h: 8, fill: ACCENTS[theme] }),
  words(80, 200, 800, 100, 48, title, { bold: true, role: 'title' }),
];
const closing = (theme, title, subtitle) => [
  words(80, 180, 800, 110, 54, title, { bold: true, align: 'center', role: 'title' }),
  words(80, 300, 800, 60, 26, subtitle, { align: 'center', role: 'subtitle' }),
];
function deck(theme, slides) {
  return { theme, slides: slides.map((els, i) => ({ id: `s${Date.now().toString(36)}${i}`, els })) };
}

export const TEMPLATES = [
  {
    key: 'letter', kind: 'doc', name: 'Letter', hint: 'to a person or a company',
    data: () => `<p>Your name<br>Your address</p><p>${today()}</p><p>Dear ______,</p><p>Write your letter here.</p><p>Yours sincerely,</p><p>Your name</p>`,
  },
  {
    key: 'cv', kind: 'doc', name: 'CV / résumé', hint: 'for a job',
    data: () => '<h1>Your name</h1><p>Phone · Email · Town</p><h2>About me</h2><p>Two or three sentences about you and the work you want.</p>'
      + '<h2>Experience</h2><p><b>Job title</b>, Company (2022 – now)</p><ul><li>What you did</li><li>Something you are proud of</li></ul>'
      + '<h2>Education</h2><p><b>Course or school</b>, Place (year)</p><h2>Skills</h2><ul><li>A skill</li><li>Another skill</li></ul>',
  },
  {
    key: 'story', kind: 'doc', name: 'Story', hint: 'make up your own',
    data: () => '<h1>The title of my story</h1><p><i>by me</i></p><p>Once upon a time…</p><h2>What happened next</h2><p></p><h2>The end</h2><p></p>',
  },
  {
    key: 'homework', kind: 'doc', name: 'School report', hint: 'homework and projects',
    data: () => `<h1>Title of my report</h1><p>Name: ______ &nbsp; Class: ______ &nbsp; Date: ${today()}</p>`
      + '<h2>Introduction</h2><p>What is this report about?</p><h2>What I found out</h2><p></p><h2>Conclusion</h2><p>What did I learn?</p><h2>Where I looked</h2><ul><li>A book or website</li></ul>',
  },
  {
    key: 'list', kind: 'doc', name: 'To-do list', hint: 'tick things off',
    data: () => '<h1>To do</h1><ul class="checklist"><li>First thing</li><li>Second thing</li><li>Third thing</li></ul>',
  },
  {
    key: 'notes', kind: 'doc', name: 'Meeting notes', hint: 'who, what, next steps',
    data: () => `<h1>Meeting notes</h1><p>${today()}</p><h2>Who was there</h2><ul><li>Name</li></ul><h2>What we talked about</h2><ul><li>Topic</li></ul><h2>What happens next</h2><ul class="checklist"><li>Task — who does it</li></ul>`,
  },
  {
    key: 'invite', kind: 'doc', name: 'Invitation', hint: 'party or event',
    data: () => '<h1 style="text-align:center">You are invited!</h1><p style="text-align:center">Please come to</p><h2 style="text-align:center">My party</h2>'
      + '<p style="text-align:center"><b>When:</b> day and time<br><b>Where:</b> the place<br><b>Reply to:</b> name and phone</p>',
  },
  {
    key: 'budget', kind: 'sheet', name: 'Monthly budget', hint: 'money in and out',
    data: () => table('Budget', [
      ['Item', 'Planned', 'Spent', 'Left'],
      ['Rent or mortgage', 0, 0, '=B2-C2'],
      ['Food', 0, 0, '=B3-C3'],
      ['Bills', 0, 0, '=B4-C4'],
      ['Travel', 0, 0, '=B5-C5'],
      ['Fun', 0, 0, '=B6-C6'],
      ['Total', '=SUM(B2:B6)', '=SUM(C2:C6)', '=B7-C7'],
    ], { color: 'green', widths: { 0: 170 } }),
  },
  {
    key: 'shopping', kind: 'sheet', name: 'Shopping list', hint: 'with tick boxes',
    data: () => table('Shopping', [
      ['Got it', 'Item', 'How many'],
      ['FALSE', 'Milk', 1],
      ['FALSE', 'Bread', 1],
      ['FALSE', 'Apples', 6],
      ['FALSE', '', ''],
      ['FALSE', '', ''],
    ], { color: 'orange', widths: { 1: 190 }, checks: [0] }),
  },
  {
    key: 'timetable', kind: 'sheet', name: 'Weekly timetable', hint: 'school or work',
    data: () => table('Timetable', [
      ['Time', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'],
      ['9:00'], ['10:00'], ['11:00'], ['12:00'], ['1:00'], ['2:00'], ['3:00'],
    ], { color: 'purple' }),
  },
  {
    key: 'chores', kind: 'sheet', name: 'Chore chart', hint: 'who does what',
    data: () => table('Chores', [
      ['Chore', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
      ...['Make the bed', 'Tidy my room', 'Feed the pet', 'Set the table'].map((c) => [c, ...Array(7).fill('FALSE')]),
    ], { color: 'blue', widths: { 0: 160 }, checks: [1, 2, 3, 4, 5, 6, 7] }),
  },
  {
    key: 'school-talk', kind: 'slides', name: 'School presentation', hint: 'a topic for class',
    data: () => deck(2, [
      titleSlide(2, 'My topic', `Your name · ${today()}`),
      bullets('What is it?', ['Say what your topic is in one sentence', 'Where or when it happens', 'Why you chose it']),
      bullets('Three interesting facts', ['First fact', 'Second fact', 'Third fact']),
      twoColumns('Good and bad', 'Good things', ['Something good', 'Another good thing'], 'Problems', ['Something hard', 'Another problem']),
      bullets('What I learned', ['The most surprising thing', 'What I would like to find out next']),
      bullets('Where I found out', ['A book or website', 'A person I asked']),
      closing(2, 'Thank you!', 'Any questions?'),
    ]),
  },
  {
    key: 'pitch', kind: 'slides', name: 'Idea pitch', hint: 'a plan, business or project',
    data: () => deck(1, [
      titleSlide(1, 'Name of your idea', 'One line that says what it does'),
      bullets('The problem', ['Who has the problem', 'What it costs them today', 'Why nothing fixes it yet']),
      bullets('Our idea', ['What we will make or do', 'How it fixes the problem', 'Why people will choose it']),
      twoColumns('How it works', 'For the people who use it', ['Step one', 'Step two', 'Step three'], 'Behind the scenes', ['What we need', 'Who does what']),
      bullets('The plan', ['First month: …', 'By three months: …', 'By the end of the year: …']),
      section(1, 'What we need from you'),
      closing(1, 'Thank you', 'Your name · email or phone'),
    ]),
  },
  {
    key: 'update', kind: 'slides', name: 'Project update', hint: 'progress for a team or boss',
    data: () => deck(0, [
      titleSlide(0, 'Project update', `Team name · ${today()}`),
      bullets('In short', ['Where we are, in one sentence', 'On time? On budget?', 'The one thing to know']),
      twoColumns('Progress', 'Done', ['Finished task', 'Finished task'], 'Next', ['Upcoming task — who, when', 'Upcoming task — who, when']),
      bullets('Problems and risks', ['What could go wrong', 'What we are doing about it', 'Help we need']),
      bullets('Decisions needed', ['Question for the group', 'Options and what we suggest']),
      closing(0, 'Questions?', 'Next update: date'),
    ]),
  },
  {
    key: 'lesson', kind: 'slides', name: 'Lesson', hint: 'for teachers and tutors',
    data: () => deck(3, [
      titleSlide(3, 'Lesson title', `Class or group · ${today()}`),
      bullets('Today we will learn', ['Goal one', 'Goal two', 'How we will know we got there']),
      bullets('Warm-up', ['A quick question or puzzle to start']),
      bullets('New idea', ['Explain it in simple words', 'An example', 'A picture or diagram helps here']),
      bullets('Your turn', ['Task for pairs or groups', 'Time: 10 minutes']),
      bullets('Check', ['A question everyone answers', 'What did you find hard?']),
      bullets('Homework', ['What to do', 'When it is due']),
    ]),
  },
  {
    key: 'book-report', kind: 'slides', name: 'Book report', hint: 'a book or film you liked',
    data: () => deck(4, [
      titleSlide(4, 'Book title', 'by the author · report by your name'),
      bullets('The story', ['Where and when it happens', 'How it starts', 'The big problem']),
      twoColumns('The characters', 'Main character', ['What they are like', 'What they want'], 'Other characters', ['Name — who they are', 'Name — who they are']),
      bullets('My favourite part', ['What happens', 'Why I liked it']),
      bullets('What I think', ['Stars out of five: ★★★★☆', 'Who would enjoy it']),
      closing(4, 'Thank you', 'Questions?'),
    ]),
  },
];

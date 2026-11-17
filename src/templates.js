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
];

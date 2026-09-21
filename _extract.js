const fs = require('fs');
const files = ['views/employee/reports.html', 'views/manager/reports.html'];
for (const f of files) {
    let s = fs.readFileSync(f, 'utf8');
    const start = s.indexOf('  <!-- Report Type Selector Cards -->');
    const end = s.indexOf('  <!-- Report Preview Bar -->');
    if (start === -1 || end === -1 || end <= start) { console.error(f + ': anchors not found'); process.exit(1); }
    const removed = s.slice(start, end);
    if (!removed.includes('report-card')) { console.error(f + ': unexpected block, aborting'); process.exit(1); }
    s = s.slice(0, start) + s.slice(end);
    fs.writeFileSync(f, s);
    console.log(f + ': removed ' + removed.length + ' chars of card grid');
}
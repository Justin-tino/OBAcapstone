const fs = require('fs');
const path = require('path');

function walkDir(dir, callback) {
  fs.readdirSync(dir).forEach(f => {
    let dirPath = path.join(dir, f);
    let isDirectory = fs.statSync(dirPath).isDirectory();
    isDirectory ? walkDir(dirPath, callback) : callback(path.join(dir, f));
  });
}

walkDir(path.join(__dirname, 'views'), function (filePath) {
  if (filePath.endsWith('.html')) {
    let content = fs.readFileSync(filePath, 'utf8');
    let changed = false;

    // Fix deleteProduct in admin/inventory
    if (content.includes("async function deleteProduct(id, biz) {\n  if (!window.confirm('Delete this product?')) return;\n  try {\n    const res = await API.del('/api/inventory/' + id + '?biz=' + biz);")) {
      content = content.replace(
        `async function deleteProduct(id, biz) {
  if (!window.confirm('Delete this product?')) return;
  try {
    const res = await API.del('/api/inventory/' + id + '?biz=' + biz);
    if (res.success) { Toast.success('Product deleted'); loadData(); }
    else { Toast.error(res.message); }
  } catch(e) { Toast.error('Error deleting'); }
}`,
        `function deleteProduct(id, biz) {
  confirm('Delete this product?', async () => {
    try {
      const res = await API.del('/api/inventory/' + id + '?biz=' + biz);
      if (res.success) { Toast.success('Product deleted'); loadData(); }
      else { Toast.error(res.message); }
    } catch(e) { Toast.error('Error deleting'); }
  });
}`
      );
      changed = true;
    }

    // Fix deleteProduct in manager/inventory and employee/inventory
    if (content.includes("async function deleteProduct(id) {\n  if (!window.confirm('Delete this product?')) return;\n  try {\n    const res = await API.del('/api/inventory/' + id + '?biz=' + BIZ);")) {
      content = content.replace(
        `async function deleteProduct(id) {
  if (!window.confirm('Delete this product?')) return;
  try {
    const res = await API.del('/api/inventory/' + id + '?biz=' + BIZ);
    if (res.success) { Toast.success('Product deleted'); loadData(); }
    else { Toast.error(res.message); }
  } catch(e) { Toast.error('Error deleting'); }
}`,
        `function deleteProduct(id) {
  confirm('Delete this product?', async () => {
    try {
      const res = await API.del('/api/inventory/' + id + '?biz=' + BIZ);
      if (res.success) { Toast.success('Product deleted'); loadData(); }
      else { Toast.error(res.message); }
    } catch(e) { Toast.error('Error deleting'); }
  });
}`
      );
      changed = true;
    }

    // Replace any remaining window.confirm that was missed
    // e.g. "if (!window.confirm('some text')) return;" -> "confirm('some text', async () => { ... });"
    // To be safe, we will just handle the exact known cases first, then check if there are others.

    if (changed) {
      fs.writeFileSync(filePath, content, 'utf8');
      console.log('Fixed delete in', filePath);
    }
  }
});

const fs = require("fs");
const p = (f) => console.log(`\n=== ${f} ===`);
const r = (c) => fs.readFileSync(c, "utf8").split(/\n/);

const check = (f) => {
  p(f);
  const lines = r(f);
  let braces = 0,
    parens = 0,
    errs = [];

  lines.forEach((l, i) => {
    const t = l.trim();
    if (t.startsWith("#")) return;

    // Count braces
    (t.match(/\{/g) || []).forEach(() => braces++);
    (t.match(/\}/g) || []).forEach(() => braces--);
    if (braces < 0) errs.push(`Line ${i + 1}: Unmatched closing brace`);

    // Count parens
    (t.match(/\(/g) || []).forEach(() => parens++);
    (t.match(/\)/g) || []).forEach(() => parens--);
    if (parens < 0) errs.push(`Line ${i + 1}: Unmatched closing paren`);

    // Check command substitution
    const csub = (t.match(/\$\(/g) || []).length;
    const close = (t.match(/\)/g) || []).length;

    // Check quotes
    const dq = (t.match(/"/g) || []).length;
    if (dq % 2 !== 0) errs.push(`Line ${i + 1}: Unmatched double quote`);
  });

  if (braces !== 0) errs.push(`Unmatched braces: ${braces}`);
  if (parens !== 0) errs.push(`Unmatched parens: ${parens}`);

  if (errs.length) {
    console.log("ERRORS FOUND:");
    errs.forEach((e) => console.log("  - " + e));
    return false;
  } else {
    console.log("OK: Basic syntax checks passed");
    return true;
  }
};

let ok = true;
["bootstrap/install-bootstrap.sh", "kiosk/start-kiosk.sh"].forEach((f) => {
  try {
    if (!check(f)) ok = false;
  } catch (e) {
    console.log(`ERROR reading ${f}: ${e.message}`);
    ok = false;
  }
});

process.exit(ok ? 0 : 1);

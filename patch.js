const fs = require('fs');
let code = fs.readFileSync('public/swift-script.js', 'utf8');

code = code.replace("const ENV = 'prod';", "const ENV = 'dev';");

const capacitorIndex = code.indexOf('// --- CAPACITOR MEDIA SESSION INTEGRATION ---');
if (capacitorIndex !== -1) {
    code = code.substring(0, capacitorIndex);
}

fs.writeFileSync('public/swift-script.js', code);

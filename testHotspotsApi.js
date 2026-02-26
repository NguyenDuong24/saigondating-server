const http = require('http');

http.get('http://localhost:3000/api/admin/hotspots', (res) => {
    let data = '';
    res.on('data', (chunk) => { data += chunk; });
    res.on('end', () => {
        console.log('Status:', res.statusCode);
        console.log('Data:', data);
    });
}).on('error', (err) => {
    console.error('Error:', err.message);
});

const CryptoJS = require('crypto-js');

function decryptSaavn(encryptedUrl) {
  try {
    const key = CryptoJS.enc.Utf8.parse('38343638');
    const decrypted = CryptoJS.DES.decrypt(
      { ciphertext: CryptoJS.enc.Base64.parse(encryptedUrl) },
      key,
      {
        mode: CryptoJS.mode.ECB,
        padding: CryptoJS.pad.Pkcs7
      }
    );
    const text = decrypted.toString(CryptoJS.enc.Utf8);
    return text.replace(/_96\.mp4/, '_320.mp4').replace(/_160\.mp4/, '_320.mp4');
  } catch (e) {
    console.error('Decryption error:', e.message);
    return null;
  }
}

// Let's test with a fresh encrypted media URL from live search
const https = require('https');
https.get('https://www.jiosaavn.com/api.php?__call=search.getResults&_marker=0&api_version=4&_format=json&n=1&p=1&q=starboy', { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
  let d = '';
  res.on('data', c => d += c);
  res.on('end', () => {
    const data = JSON.parse(d.trim());
    const song = data.results[0];
    const enc = song.more_info.encrypted_media_url;
    console.log('Song title:', song.title);
    console.log('Encrypted URL:', enc);
    
    // Test direct decryption in JS
    const key = CryptoJS.enc.Utf8.parse('38343638');
    const decrypted = CryptoJS.DES.decrypt(
      { ciphertext: CryptoJS.enc.Base64.parse(enc) },
      key,
      { mode: CryptoJS.mode.ECB, padding: CryptoJS.pad.Pkcs7 }
    );
    console.log('Decrypted URL:', decrypted.toString(CryptoJS.enc.Utf8));
  });
});

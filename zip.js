// Maakt een zip-bestand zonder compressie (video's worden toch niet kleiner).
// Geen externe bibliotheek nodig, zodat de app ook offline werkt.
'use strict';

const CRC_TABEL = (() => {
  const tabel = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    tabel[n] = c >>> 0;
  }
  return tabel;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABEL[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosTijd(d) {
  return {
    tijd: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    datum: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

// bestanden: [{ naam: 'map/bestand.mp4', blob: Blob }]
// voortgang: functie die een getal tussen 0 en 1 krijgt
async function maakZip(bestanden, voortgang = () => {}) {
  const encoder = new TextEncoder();
  const { tijd, datum } = dosTijd(new Date());
  const delen = [];
  const centraal = [];
  let offset = 0;

  for (let i = 0; i < bestanden.length; i++) {
    const { naam, blob } = bestanden[i];
    const crc = crc32(new Uint8Array(await blob.arrayBuffer()));
    const naamBytes = encoder.encode(naam);
    const grootte = blob.size;

    const lokaal = new DataView(new ArrayBuffer(30));
    lokaal.setUint32(0, 0x04034b50, true);
    lokaal.setUint16(4, 20, true);        // benodigde versie
    lokaal.setUint16(6, 0x0800, true);    // bestandsnamen in UTF-8
    lokaal.setUint16(8, 0, true);         // geen compressie
    lokaal.setUint16(10, tijd, true);
    lokaal.setUint16(12, datum, true);
    lokaal.setUint32(14, crc, true);
    lokaal.setUint32(18, grootte, true);
    lokaal.setUint32(22, grootte, true);
    lokaal.setUint16(26, naamBytes.length, true);
    lokaal.setUint16(28, 0, true);
    delen.push(lokaal.buffer, naamBytes, blob);

    const kop = new DataView(new ArrayBuffer(46));
    kop.setUint32(0, 0x02014b50, true);
    kop.setUint16(4, 20, true);
    kop.setUint16(6, 20, true);
    kop.setUint16(8, 0x0800, true);
    kop.setUint16(10, 0, true);
    kop.setUint16(12, tijd, true);
    kop.setUint16(14, datum, true);
    kop.setUint32(16, crc, true);
    kop.setUint32(20, grootte, true);
    kop.setUint32(24, grootte, true);
    kop.setUint16(28, naamBytes.length, true);
    kop.setUint32(42, offset, true);      // overige velden blijven 0
    centraal.push(kop.buffer, naamBytes);

    offset += 30 + naamBytes.length + grootte;
    voortgang((i + 1) / bestanden.length);
    await new Promise((r) => setTimeout(r, 0)); // scherm laten bijwerken
  }

  const centraalGrootte = centraal.reduce((som, d) => som + d.byteLength, 0);
  const einde = new DataView(new ArrayBuffer(22));
  einde.setUint32(0, 0x06054b50, true);
  einde.setUint16(8, bestanden.length, true);
  einde.setUint16(10, bestanden.length, true);
  einde.setUint32(12, centraalGrootte, true);
  einde.setUint32(16, offset, true);

  return new Blob([...delen, ...centraal, einde.buffer], { type: 'application/zip' });
}

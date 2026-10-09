// Bewaart opnames op het apparaat zelf (IndexedDB). Er gaat niets naar internet.
'use strict';

const opslag = (() => {
  let db = null;

  function open() {
    if (db) return Promise.resolve(db);
    return new Promise((klaar, mislukt) => {
      const verzoek = indexedDB.open('ngt-opnemen', 1);
      verzoek.onupgradeneeded = () => {
        const d = verzoek.result;
        const takes = d.createObjectStore('takes', { keyPath: 'sleutel' });
        takes.createIndex('gebaar', 'gebaar');
        d.createObjectStore('beste', { keyPath: 'gebaar' });
      };
      verzoek.onsuccess = () => { db = verzoek.result; klaar(db); };
      verzoek.onerror = () => mislukt(verzoek.error);
    });
  }

  async function transactie(winkels, modus, werk) {
    const d = await open();
    return new Promise((klaar, mislukt) => {
      const tx = d.transaction(winkels, modus);
      let resultaat;
      tx.oncomplete = () => klaar(resultaat);
      tx.onerror = () => mislukt(tx.error);
      tx.onabort = () => mislukt(tx.error || new Error('Opslaan afgebroken'));
      resultaat = werk(tx);
    });
  }

  function alles(verzoek) {
    return new Promise((klaar, mislukt) => {
      verzoek.onsuccess = () => klaar(verzoek.result);
      verzoek.onerror = () => mislukt(verzoek.error);
    });
  }

  function zonderVideo(take) {
    const { blob, ...rest } = take;
    return rest;
  }

  return {
    // Alle opnames zonder de video zelf: { gebaarId: [take, ...] } en { gebaarId: nummer }
    async overzicht() {
      const d = await open();
      const tx = d.transaction(['takes', 'beste'], 'readonly');
      const takes = [];
      await new Promise((klaar, mislukt) => {
        const cursor = tx.objectStore('takes').openCursor();
        cursor.onsuccess = () => {
          const c = cursor.result;
          if (!c) return klaar();
          takes.push(zonderVideo(c.value));
          c.continue();
        };
        cursor.onerror = () => mislukt(cursor.error);
      });
      const besten = await alles(tx.objectStore('beste').getAll());
      const perGebaar = {};
      for (const t of takes) (perGebaar[t.gebaar] ||= []).push(t);
      Object.values(perGebaar).forEach((l) => l.sort((a, b) => a.nummer - b.nummer));
      return { takes: perGebaar, beste: Object.fromEntries(besten.map((b) => [b.gebaar, b.nummer])) };
    },

    async bewaarTake(take) {
      await transactie(['takes'], 'readwrite', (tx) => tx.objectStore('takes').put(take));
      return zonderVideo(take);
    },

    async video(sleutel) {
      const d = await open();
      const take = await alles(d.transaction('takes').objectStore('takes').get(sleutel));
      return take ? take.blob : null;
    },

    async wisTake(gebaar, nummer) {
      await transactie(['takes', 'beste'], 'readwrite', (tx) => {
        tx.objectStore('takes').delete(`${gebaar}/${nummer}`);
        const beste = tx.objectStore('beste');
        const v = beste.get(gebaar);
        v.onsuccess = () => { if (v.result && v.result.nummer === nummer) beste.delete(gebaar); };
      });
    },

    async kiesBeste(gebaar, nummer) {
      await transactie(['beste'], 'readwrite', (tx) => tx.objectStore('beste').put({ gebaar, nummer }));
    },

    async markeerVerstuurd(sleutels) {
      const tijd = new Date().toISOString();
      await transactie(['takes'], 'readwrite', (tx) => {
        const winkel = tx.objectStore('takes');
        for (const s of sleutels) {
          const v = winkel.get(s);
          v.onsuccess = () => { if (v.result) winkel.put({ ...v.result, verstuurd: tijd }); };
        }
      });
    },

    // Vraagt de browser de opnames niet zomaar op te ruimen bij weinig ruimte
    async vraagBlijvendeOpslag() {
      try {
        if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist();
      } catch (e) { /* niet ondersteund */ }
      return false;
    },
  };
})();

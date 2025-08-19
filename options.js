const ext = typeof browser !== 'undefined' ? browser : chrome;

async function load() {
  const { spotifyClientId, spotifyClientSecret } = await ext.storage.sync.get([
    'spotifyClientId',
    'spotifyClientSecret'
  ]);
  document.getElementById('clientId').value = spotifyClientId || '';
  document.getElementById('clientSecret').value = spotifyClientSecret || '';
}

async function save() {
  const spotifyClientId = document.getElementById('clientId').value.trim();
  const spotifyClientSecret = document.getElementById('clientSecret').value.trim();

  await ext.storage.sync.set({ spotifyClientId, spotifyClientSecret });

  const status = document.getElementById('status');
  status.textContent = 'Saved!';
  setTimeout(() => (status.textContent = ''), 2000);
}

document.getElementById('saveBtn').addEventListener('click', save);
load();

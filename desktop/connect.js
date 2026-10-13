// The connect page: asks for the server's address, or explains why it couldn't be opened.
const params = new URLSearchParams(location.search);
const form = document.getElementById('form');
const input = document.getElementById('server');
const connect = document.getElementById('connect');
const retry = document.getElementById('retry');
const error = document.getElementById('error');

function showError(message) {
  error.textContent = message;
  error.hidden = !message;
}

input.value = params.get('server') ?? '';
showError(params.get('error') ?? '');
retry.hidden = !params.get('retry');

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  connect.disabled = true;
  connect.textContent = 'Connecting…';
  showError('');
  const result = await window.gungnir.setServer(input.value);
  if (!result.ok) {
    showError(result.error);
    connect.disabled = false;
    connect.textContent = 'Connect';
  }
});

retry.addEventListener('click', () => {
  retry.disabled = true;
  void window.gungnir.retry();
});

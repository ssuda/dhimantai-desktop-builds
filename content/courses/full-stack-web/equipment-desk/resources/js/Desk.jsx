import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

function EquipmentDesk() {
  const [items, setItems] = useState([]);
  const [message, setMessage] = useState('Loading equipment…');
  const [busy, setBusy] = useState(false);

  async function loadItems() {
    const response = await fetch('/items', { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error('Equipment could not be loaded. Refresh to try again.');
    const rows = await response.json();
    setItems(rows);
    return rows;
  }

  useEffect(() => {
    loadItems().then(rows => setMessage(rows.length ? '' : 'No equipment is listed.'))
      .catch(error => setMessage(error.message));
  }, []);

  async function checkout(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    setBusy(true);
    setMessage('Saving checkout…');
    try {
      const response = await fetch('/items/' + fields.get('item') + '/loans', {
        method: 'POST',
        headers: {
          Accept: 'application/json', 'Content-Type': 'application/json',
          'X-CSRF-TOKEN': document.querySelector('meta[name="csrf-token"]').content,
        },
        body: JSON.stringify({ borrower: fields.get('borrower'), quantity: Number(fields.get('quantity')) }),
      });
      const result = await response.json();
      if (!response.ok) {
        if (response.status === 409) await loadItems();
        throw new Error(result.message || 'Checkout failed. Check the inventory before retrying.');
      }
      const id = Number(fields.get('item'));
      setItems(previous => previous.map(item => item.id === id ? { ...item, available: result.available } : item));
      setMessage('Checkout ' + result.id + ' recorded.');
      form.reset();
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy(false);
    }
  }

  return <>
    <ul>{items.map(item => <li key={item.id}>{item.name} · {item.available} available</li>)}</ul>
    <form onSubmit={checkout}>
      <label>Equipment <select name="item" required>{items.map(item =>
        <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <label>Borrower alias <input name="borrower" required maxLength={60} /></label>
      <label>Quantity <input name="quantity" type="number" min="1" max="20" defaultValue="1" required /></label>
      <button disabled={busy || !items.length}>Check out</button>
    </form>
    <p role="status">{message}</p>
  </>;
}

createRoot(document.getElementById('desk')).render(<EquipmentDesk />);

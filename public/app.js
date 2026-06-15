const EXAMPLE_VALID = `// Programa JavaScript de ejemplo
class Animal {
    constructor(nombre) {
        this.nombre = nombre;
    }
    saludar() {
        return \`Hola, soy \${this.nombre}\`;
    }
}

const PI = 3.14159;
const HEX = 0xFF;
const BIN = 0b1010;
let contador = 0;

const sumar = (a, b) => a + b;

function factorial(n) {
    if (n <= 1) return 1;
    return n * factorial(n - 1);
}

for (let i = 0; i < 10; i++) {
    contador += i;
    if (contador === 42) break;
}

const lista = [1, 2, 3, ...[4, 5]];
`;

const EXAMPLE_ERRORS = `class Cuenta {
  constructor(saldo) {
    this.saldo = saldo;
  }
  depositar(monto) {
    if (monto <= 0 return;
    this.saldo += monto;
  }
  retirar(monto) {
    if (monto > this.saldo) {
      throw "fondos insuficientes;
    }
    this.saldo -= monto
  }
}

let cuenta = new Cuenta(100);
const tasa = 0.05 *;
function calcular(a, b {
  return a + b;
}

const datos = [1, 2, 3 4];
let @id = 99;
/* reporte final nunca cierra
const fin = \`total pendiente
`;

const src = document.getElementById('src');
const status = document.getElementById('status');
const tokensBody = document.querySelector('#tokens tbody');
const errorsBody = document.querySelector('#errors tbody');
const tokCount = document.getElementById('tok-count');
const errCount = document.getElementById('err-count');
const tokensEmpty = document.getElementById('tokens-empty');
const errorsEmpty = document.getElementById('errors-empty');
const synResult = document.getElementById('syn-result');
const synBody = document.querySelector('#syn-errors tbody');
const synCount = document.getElementById('syn-count');
const synEmpty = document.getElementById('syn-errors-empty');

src.value = EXAMPLE_VALID;

document.getElementById('btn-load-valid').onclick = function () {
  src.value = EXAMPLE_VALID;
};
document.getElementById('btn-load-errors').onclick = function () {
  src.value = EXAMPLE_ERRORS;
};
document.getElementById('btn-analyze').onclick = analyze;
document.getElementById('btn-parse').onclick = parseSyntax;

function renderRows(tbody, items, makeRow) {
  while (tbody.firstChild) tbody.removeChild(tbody.firstChild);
  for (let i = 0; i < items.length; i++) {
    const tr = document.createElement('tr');
    const cells = makeRow(items[i], i + 1);
    for (let j = 0; j < cells.length; j++) {
      const td = document.createElement('td');
      td.textContent = String(cells[j]);
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
}

function analyze() {
  const source = src.value;
  status.textContent = 'Analizando...';

  fetch('/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: source })
  })
    .then(function (res) {
      return res.json();
    })
    .then(function (data) {
      const tokens = data.tokens || [];
      const errors = data.errors || [];

      renderRows(tokensBody, tokens, function (t, i) {
        return [i, t.type, t.lexeme, t.line, t.column];
      });
      renderRows(errorsBody, errors, function (e, i) {
        return [i, e.message, e.lexeme, e.line, e.column];
      });

      tokCount.textContent = tokens.length;
      errCount.textContent = errors.length;
      tokensEmpty.classList.toggle('hidden', tokens.length > 0);
      errorsEmpty.classList.toggle('hidden', errors.length > 0);

      status.textContent = '';
    })
    .catch(function (e) {
      status.textContent = 'Error: ' + e.message;
    });
}

function parseSyntax() {
  const source = src.value;
  status.textContent = 'Analizando sintaxis...';

  fetch('/parse', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: source })
  })
    .then(function (res) {
      return res.json();
    })
    .then(function (data) {
      const tokens = data.tokens || [];
      const lexErrors = data.lexErrors || [];
      const synErrors = data.synErrors || [];

      // Tablas lexicas (tokens + errores lexicos)
      renderRows(tokensBody, tokens, function (t, i) {
        return [i, t.type, t.lexeme, t.line, t.column];
      });
      renderRows(errorsBody, lexErrors, function (e, i) {
        return [i, e.message, e.lexeme, e.line, e.column];
      });
      tokCount.textContent = tokens.length;
      errCount.textContent = lexErrors.length;
      tokensEmpty.classList.toggle('hidden', tokens.length > 0);
      errorsEmpty.classList.toggle('hidden', lexErrors.length > 0);

      if (synErrors.length === 0) {
        synResult.textContent = 'Sintaxis valida.';
        synResult.className = 'result ok';
      } else {
        synResult.textContent = 'Sintaxis invalida: ' + synErrors.length + ' error(es).';
        synResult.className = 'result bad';
      }

      renderRows(synBody, synErrors, function (e, i) {
        return [i, e.message, e.lexeme, e.line, e.column];
      });
      synCount.textContent = synErrors.length;
      synEmpty.classList.toggle('hidden', synErrors.length > 0);

      status.textContent = '';
    })
    .catch(function (e) {
      status.textContent = 'Error: ' + e.message;
    });
}

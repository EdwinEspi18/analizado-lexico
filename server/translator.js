"use strict";

// ─── Base ────────────────────────────────────────────────────────────────────

class Translator {
  constructor() { this.depth = 0; }
  ind() { return '    '.repeat(this.depth); }
  translate(ast) { return this.visit(ast) || ''; }
  visit(node) {
    if (!node || typeof node.tipo !== 'string') return '';
    const m = 'visit' + node.tipo;
    if (typeof this[m] === 'function') return this[m](node);
    return (node.hijos || []).map(h => this.visit(h)).filter(Boolean).join('\n');
  }
  ch(node, i) { return (node && node.hijos && node.hijos[i]) || null; }
  unwrap(node) { return this.ch(node, 0); }
}

// ─── Type Inferrer ───────────────────────────────────────────────────────────

class TypeInferrer {
  constructor() {
    this._scope    = new Map(); // varName → type
    this._listElem = new Map(); // varName → element type (for list vars)
    this._fnReturn = new Map(); // fnName  → return type
  }

  run(ast) { this._walk(ast); return this; }

  typeOf(name)     { return this._scope.get(name)    || 'unknown'; }
  elemTypeOf(name) { return this._listElem.get(name) || 'unknown'; }

  _typeOf(node) {
    if (!node) return 'unknown';
    switch (node.tipo) {
      case 'Arreglo':    return 'list';
      case 'Objeto':     return 'dict';
      case 'Cadena': case 'Template': return 'str';
      case 'Numero':     return 'num';
      case 'Booleano':   return 'bool';
      case 'FuncionFlecha': case 'FuncionExpr': case 'DeclaracionFuncion': return 'fn';
      case 'Nuevo':      return 'instance';
      case 'Identificador': return this._scope.get(node.valor) || 'unknown';
      case 'AccesoIndice': {
        const obj = node.hijos[0];
        if (obj && obj.tipo === 'Identificador')
          return this._listElem.get(obj.valor) || 'unknown';
        return 'unknown';
      }
      case 'Llamada': {
        const callee = node.hijos[0];
        if (callee && callee.tipo === 'Identificador')
          return this._fnReturn.get(callee.valor) || 'unknown';
        return 'unknown';
      }
      default: return 'unknown';
    }
  }

  _scanReturn(node) {
    if (!node) return 'unknown';
    if (node.tipo === 'SentenciaReturn' && node.hijos[0]) {
      const t = this._typeOf(node.hijos[0]);
      if (t !== 'unknown') return t;
    }
    // don't cross nested function scopes
    if (node.tipo === 'DeclaracionFuncion' || node.tipo === 'FuncionExpr' || node.tipo === 'FuncionFlecha') return 'unknown';
    for (const h of node.hijos || []) {
      const t = this._scanReturn(h);
      if (t !== 'unknown') return t;
    }
    return 'unknown';
  }

  _listElemType(arregloNode) {
    for (const h of arregloNode.hijos || []) {
      if (h.tipo === 'Objeto')  return 'dict';
      if (h.tipo === 'Numero')  return 'num';
      if (h.tipo === 'Cadena')  return 'str';
    }
    return 'unknown';
  }

  _walk(node) {
    if (!node || typeof node.tipo !== 'string') return;

    if (node.tipo === 'DeclaracionFuncion' && node.valor && node.hijos[1]) {
      const ret = this._scanReturn(node.hijos[1]);
      if (ret !== 'unknown') this._fnReturn.set(node.valor, ret);
    }

    if (node.tipo === 'DeclaracionVariable') {
      for (const d of node.hijos || []) {
        if (d.tipo === 'Declarador' && d.hijos[0]) {
          const t = this._typeOf(d.hijos[0]);
          this._scope.set(d.valor, t);
          if (t === 'list' && d.hijos[0].tipo === 'Arreglo') {
            const et = this._listElemType(d.hijos[0]);
            if (et !== 'unknown') this._listElem.set(d.valor, et);
          }
        }
      }
    }

    if (node.tipo === 'Asignacion') {
      const lhsW = node.hijos[0], rhsW = node.hijos[1];
      const lhs = lhsW && lhsW.hijos && lhsW.hijos[0];
      const rhs = rhsW && rhsW.hijos && rhsW.hijos[0];
      if (lhs && lhs.tipo === 'Identificador' && rhs)
        this._scope.set(lhs.valor, this._typeOf(rhs));
    }

    for (const h of node.hijos || []) this._walk(h);
  }
}

// ─── Python ──────────────────────────────────────────────────────────────────

class PythonTranslator extends Translator {
  constructor() {
    super();
    this._arrowCount = 0;
    this._currentClass = null;
    this._deferred = [];
    this._localStack = [[]];
    this._ti = null;
  }

  translate(ast) {
    this._ti = new TypeInferrer();
    this._ti.run(ast);
    const body = this.visit(ast);
    const topDefs = this._localStack[0].join('\n\n');
    const defs = [topDefs, ...this._deferred].filter(Boolean).join('\n\n');
    return defs ? defs + '\n\n' + body : body;
  }

  // ── Statements ──────────────────────────────────────────────────────────────

  visitPrograma(node) {
    return (node.hijos || []).map(h => this.visit(h)).filter(Boolean).join('\n');
  }

  visitDeclaracionVariable(node) {
    const kind = node.valor;
    const lines = [];
    for (const d of node.hijos) {
      if (d.tipo !== 'Declarador') continue;
      const init = d.hijos[0] ? this.e(d.hijos[0]) : 'None';
      const suffix = kind === 'const' ? '  # const' : '';
      lines.push(`${this.ind()}${d.valor} = ${init}${suffix}`);
    }
    return lines.join('\n');
  }

  visitDeclaracionFuncion(node) {
    const params = this._params(this.ch(node, 0), false);
    const body = this._body(this.ch(node, 1));
    return `${this.ind()}def ${node.valor}(${params}):\n${body}`;
  }

  visitDeclaracionClase(node) {
    const hijos = node.hijos || [];
    let base = '', start = 0;
    if (hijos[0] && hijos[0].tipo === 'Extiende') { base = `(${hijos[0].valor})`; start = 1; }
    const ind = this.ind();
    const prev = this._currentClass;
    this._currentClass = node.valor;
    this.depth++;
    const innerInd = this.ind();
    const members = hijos.slice(start).map(m => this.visit(m)).filter(Boolean);
    this.depth--;
    this._currentClass = prev;
    const body = members.length ? members.join('\n') : `${innerInd}pass`;
    return `${ind}class ${node.valor}${base}:\n${body}`;
  }

  visitMetodo(node) {
    const rawName = node.valor;
    const isStatic = rawName.startsWith('static ');
    const name = isStatic ? rawName.slice(7) : rawName;
    const pyName = name === 'constructor' ? '__init__' : name;
    const params = this._params(node.hijos[0], !isStatic);
    const body = this._body(node.hijos[1]);
    const ind = this.ind();
    const decorator = isStatic ? `${ind}@staticmethod\n` : '';
    return `${decorator}${ind}def ${pyName}(${params}):\n${body}`;
  }

  visitCampo(node) {
    const raw = node.valor;
    const name = raw.startsWith('static ') ? raw.slice(7) : raw;
    const init = node.hijos[0] ? this.e(node.hijos[0]) : 'None';
    return `${this.ind()}${name} = ${init}`;
  }

  visitSentenciaIf(node) {
    const [condW, thenW, elseW] = node.hijos;
    const cond = this.e(this.unwrap(condW));
    const ind = this.ind();
    let out = `${ind}if ${cond}:\n${this._body(this.unwrap(thenW))}`;
    if (elseW) {
      const en = this.unwrap(elseW);
      if (en && en.tipo === 'SentenciaIf') {
        out += `\n${ind}el${this.visit(en).replace(/^\s*/, '')}`;
      } else {
        out += `\n${ind}else:\n${this._body(en)}`;
      }
    }
    return out;
  }

  visitSentenciaFor(node) {
    const [initW, condW, updW, bodyW] = node.hijos;
    const initN = this.unwrap(initW), condN = this.unwrap(condW);
    const updN = this.unwrap(updW), bodyN = this.unwrap(bodyW);
    const ind = this.ind();
    const range = this._tryRange(initN, condN, updN);
    if (range) return `${ind}for ${range}:\n${this._body(bodyN)}`;
    // fallback → while
    const lines = [];
    if (initN) { const s = this.visit(initN); if (s) lines.push(s); }
    const cond = condN ? this.e(condN) : 'True';
    lines.push(`${ind}while ${cond}:`);
    this.depth++;
    const innerInd = this.ind();
    const bodyLines = this._bodyLines(bodyN);
    if (updN) { const u = this._updStmt(updN); if (u) bodyLines.push(`${innerInd}${u}`); }
    if (!bodyLines.length) bodyLines.push(`${innerInd}pass`);
    this.depth--;
    lines.push(bodyLines.join('\n'));
    return lines.join('\n');
  }

  visitSentenciaForIn(node) {
    const [varW, iterW, bodyW] = node.hijos;
    const varName = this._varName(this.unwrap(varW));
    const iterable = this.e(this.unwrap(iterW));
    return `${this.ind()}for ${varName} in ${iterable}:\n${this._body(this.unwrap(bodyW))}`;
  }

  visitSentenciaForOf(node) {
    const [varW, iterW, bodyW] = node.hijos;
    const varName = this._varName(this.unwrap(varW));
    const iterable = this.e(this.unwrap(iterW));
    return `${this.ind()}for ${varName} in ${iterable}:\n${this._body(this.unwrap(bodyW))}`;
  }

  visitSentenciaWhile(node) {
    const cond = this.e(this.unwrap(node.hijos[0]));
    return `${this.ind()}while ${cond}:\n${this._body(this.unwrap(node.hijos[1]))}`;
  }

  visitSentenciaDoWhile(node) {
    const [bodyW, condW] = node.hijos;
    const cond = this.e(this.unwrap(condW));
    const ind = this.ind();
    this.depth++;
    const innerInd = this.ind();
    const bodyLines = this._bodyLines(this.unwrap(bodyW));
    bodyLines.push(`${innerInd}if not (${cond}): break`);
    this.depth--;
    return `${ind}while True:\n${bodyLines.join('\n')}`;
  }

  visitSentenciaSwitch(node) {
    const [discW, ...cases] = node.hijos;
    const disc = this.e(this.unwrap(discW));
    const ind = this.ind();
    const lines = [`${ind}match ${disc}:`];
    this.depth++;
    for (const c of cases) {
      if (c.tipo === 'Caso') {
        const val = this.e(this.unwrap(c.hijos[0]));
        lines.push(`${this.ind()}case ${val}:`);
        this.depth++;
        const ss = c.hijos.slice(1).map(s => this.visit(s)).filter(Boolean);
        lines.push(ss.length ? ss.join('\n') : `${this.ind()}pass`);
        this.depth--;
      } else if (c.tipo === 'CasoDefault') {
        lines.push(`${this.ind()}case _:`);
        this.depth++;
        const ss = c.hijos.map(s => this.visit(s)).filter(Boolean);
        lines.push(ss.length ? ss.join('\n') : `${this.ind()}pass`);
        this.depth--;
      }
    }
    this.depth--;
    return lines.join('\n');
  }

  visitSentenciaReturn(node) {
    const val = node.hijos[0] ? this.e(node.hijos[0]) : null;
    return val ? `${this.ind()}return ${val}` : `${this.ind()}return`;
  }

  visitSentenciaBreak() { return `${this.ind()}break`; }
  visitSentenciaContinue() { return `${this.ind()}continue`; }

  visitSentenciaThrow(node) {
    return `${this.ind()}raise Exception(${this.e(node.hijos[0])})`;
  }

  visitSentenciaTry(node) {
    const [intentarW, ...rest] = node.hijos;
    const ind = this.ind();
    const parts = [`${ind}try:\n${this._body(this.unwrap(intentarW))}`];
    for (const r of rest) {
      if (r.tipo === 'Catch') {
        const as = r.valor ? ` as ${r.valor}` : '';
        parts.push(`${ind}except Exception${as}:\n${this._body(r.hijos[0])}`);
      } else if (r.tipo === 'Finally') {
        parts.push(`${ind}finally:\n${this._body(this.unwrap(r))}`);
      }
    }
    return parts.join('\n');
  }

  visitBloque(node) {
    this.depth++;
    const ind = this.ind();
    this._localStack.push([]);
    const ss = (node.hijos || []).map(h => this.visit(h)).filter(Boolean);
    const localDefs = this._localStack.pop();
    this.depth--;
    const all = [...localDefs, ...ss];
    return all.length ? all.join('\n') : `${ind}pass`;
  }

  visitSentenciaExpresion(node) {
    const inner = node.hijos[0];
    if (!inner) return '';
    if (inner.tipo === 'PostIncremento') {
      const op = inner.valor === '++' ? '+= 1' : '-= 1';
      return `${this.ind()}${this.e(inner.hijos[0])} ${op}`;
    }
    if (inner.tipo === 'OperacionUnaria' && (inner.valor === '++' || inner.valor === '--')) {
      const op = inner.valor === '++' ? '+= 1' : '-= 1';
      return `${this.ind()}${this.e(inner.hijos[0])} ${op}`;
    }
    return `${this.ind()}${this.e(inner)}`;
  }

  // ── Expressions ─────────────────────────────────────────────────────────────

  e(node) { return this.visit(node); }

  visitAsignacion(node) {
    const lhs = this.e(this.unwrap(node.hijos[0]));
    const rhs = this.e(this.unwrap(node.hijos[1]));
    const op = { '&&=': 'and=', '||=': 'or=', '??=': 'or=' }[node.valor] || node.valor;
    return `${lhs} ${op} ${rhs}`;
  }

  visitTernario(node) {
    const [cW, tW, eW] = node.hijos;
    return `${this.e(this.unwrap(tW))} if ${this.e(this.unwrap(cW))} else ${this.e(this.unwrap(eW))}`;
  }

  visitOperacionBinaria(node) {
    const l = this.e(node.hijos[0]), r = this.e(node.hijos[1]);
    const op = node.valor;
    if (op === 'instanceof') return `isinstance(${l}, ${r})`;
    if (op === 'in') return `${l} in ${r}`;
    if (op === '+') {
      const lt = this._getType(node.hijos[0]);
      const rt = this._getType(node.hijos[1]);
      if (lt === 'str' && rt !== 'str') return `${l} + str(${r})`;
      if (rt === 'str' && lt !== 'str') return `str(${l}) + ${r}`;
    }
    const map = { '===': '==', '!==': '!=', '&&': 'and', '||': 'or', '??': 'or' };
    return `${l} ${map[op] || op} ${r}`;
  }

  visitOperacionUnaria(node) {
    const op = node.valor, o = this.e(node.hijos[0]);
    switch (op) {
      case '!': return `not ${o}`;
      case 'typeof': return `type(${o}).__name__`;
      case 'void': return 'None';
      case 'delete': return `None  # delete ${o}`;
      case '++': return `${o} + 1`;
      case '--': return `${o} - 1`;
      case 'await': return `await ${o}`;
      case 'yield': return `yield ${o}`;
      default: return `${op}${o}`;
    }
  }

  visitNuevo(node) {
    const inner = node.hijos[0];
    if (inner && inner.tipo === 'Llamada') return this.visitLlamada(inner);
    return this.e(inner);
  }

  visitLlamada(node) {
    const callee = node.hijos[0], argsNode = node.hijos[1];
    const args = this._args(argsNode);
    if (this._isConsoleLog(callee)) return `print(${args})`;
    if (callee && callee.tipo === 'AccesoMiembro') {
      const objType = this._getType(callee.hijos[0]);
      const objStr  = this.e(callee.hijos[0]);
      const method  = callee.valor;
      if (objType === 'list') {
        switch (method) {
          case 'push':    return `${objStr}.append(${args})`;
          case 'pop':     return `${objStr}.pop(${args})`;
          case 'shift':   return `${objStr}.pop(0)`;
          case 'unshift': return `${objStr}.insert(0, ${args})`;
          case 'includes':return `(${args} in ${objStr})`;
          case 'indexOf': return `${objStr}.index(${args})`;
          case 'join':    return `(${args || '""'}).join(str(x) for x in ${objStr})`;
          case 'reverse': return `${objStr}.reverse()`;
          case 'sort':    return `${objStr}.sort()`;
          case 'concat':  return `${objStr} + [${args}]`;
          case 'map':     return `list(map(${args}, ${objStr}))`;
          case 'filter':  return `list(filter(${args}, ${objStr}))`;
          case 'forEach': return `list(map(${args}, ${objStr}))`;
          case 'some':    return `any(${args}(x) for x in ${objStr})`;
          case 'every':   return `all(${args}(x) for x in ${objStr})`;
          case 'find':    return `next((x for x in ${objStr} if ${args}(x)), None)`;
          case 'flat':    return `[x for sub in ${objStr} for x in sub]`;
          case 'slice':   return `${objStr}[${args.replace(',', ':')}]`;
        }
      }
      if (objType === 'str') {
        switch (method) {
          case 'toUpperCase':  case 'toLocaleUpperCase': return `${objStr}.upper()`;
          case 'toLowerCase':  case 'toLocaleLowerCase': return `${objStr}.lower()`;
          case 'trim':         return `${objStr}.strip()`;
          case 'trimStart':    case 'trimLeft':  return `${objStr}.lstrip()`;
          case 'trimEnd':      case 'trimRight': return `${objStr}.rstrip()`;
          case 'split':        return `${objStr}.split(${args})`;
          case 'includes':     return `(${args} in ${objStr})`;
          case 'indexOf':      return `${objStr}.find(${args})`;
          case 'startsWith':   return `${objStr}.startswith(${args})`;
          case 'endsWith':     return `${objStr}.endswith(${args})`;
          case 'replace':      return `${objStr}.replace(${args})`;
          case 'repeat':       return `${objStr} * ${args}`;
          case 'charAt':       return `${objStr}[${args}]`;
          case 'charCodeAt':   return `ord(${objStr}[${args}])`;
          case 'padStart':     return `${objStr}.rjust(${args})`;
          case 'padEnd':       return `${objStr}.ljust(${args})`;
        }
      }
    }
    return `${this.e(callee)}(${args})`;
  }

  visitAccesoMiembro(node) {
    const objType = this._getType(node.hijos[0]);
    const objStr  = this.e(node.hijos[0]);
    const prop    = node.valor;
    if (prop === 'length') return `len(${objStr})`;
    if (objType === 'dict') return `${objStr}["${prop}"]`;
    return `${objStr}.${prop}`;
  }

  visitAccesoOpcional(node) {
    const obj = this.e(node.hijos[0]);
    return `(${obj}.${node.valor} if ${obj} is not None else None)`;
  }

  visitAccesoIndice(node) {
    return `${this.e(node.hijos[0])}[${this.e(this.unwrap(node.hijos[1]))}]`;
  }

  visitPostIncremento(node) { return this.e(node.hijos[0]); }

  visitFuncionFlecha(node) {
    const body = node.hijos[1];
    const params = this._params(node.hijos[0], false);
    if (body && body.tipo === 'Cuerpo') return `lambda ${params}: ${this.e(body.hijos[0])}`;
    const name = `_arrow_${++this._arrowCount}`;
    const ind = this.ind();
    const b = this._body(body);
    const defStr = `${ind}def ${name}(${params}):\n${b}`;
    this._localStack[this._localStack.length - 1].push(defStr);
    return name;
  }

  visitFuncionExpr(node) {
    const params = this._params(node.hijos[0], false);
    const body = node.hijos[1];
    // single-return block → lambda
    if (body && body.tipo === 'Bloque' && body.hijos.length === 1) {
      const s = body.hijos[0];
      if (s && s.tipo === 'SentenciaReturn' && s.hijos[0]) {
        return `lambda ${params}: ${this.e(s.hijos[0])}`;
      }
    }
    const name = node.valor || `_fn_${++this._arrowCount}`;
    const ind = this.ind();
    const b = this._body(body);
    const defStr = `${ind}def ${name}(${params}):\n${b}`;
    this._localStack[this._localStack.length - 1].push(defStr);
    return name;
  }

  visitArreglo(node) {
    const items = (node.hijos || []).map(h =>
      h.tipo === 'Spread' ? `*${this.e(h.hijos[0])}` : this.e(h)
    );
    return `[${items.join(', ')}]`;
  }

  visitObjeto(node) {
    const pairs = (node.hijos || []).map(h => {
      if (h.tipo === 'Spread') return `**${this.e(h.hijos[0])}`;
      if (h.tipo === 'MetodoObjeto') {
        const p = this._params(h.hijos[0], false);
        const b = h.hijos[1];
        if (b && b.tipo === 'Bloque' && b.hijos.length === 1) {
          const s = b.hijos[0];
          if (s && s.tipo === 'SentenciaReturn' && s.hijos[0]) {
            return `"${h.valor}": lambda ${p}: ${this.e(s.hijos[0])}`;
          }
        }
        return `"${h.valor}": None  # method`;
      }
      if (h.tipo === 'Propiedad') {
        const key = h.valor === '[computada]'
          ? `[${this.e(h.hijos[0] && h.hijos[0].hijos[0])}]`
          : `"${h.valor}"`;
        const val = h.hijos[0]
          ? (h.valor === '[computada]' ? this.e(h.hijos[1] && h.hijos[1].hijos[0]) : this.e(h.hijos[0]))
          : h.valor;
        return `${key}: ${val}`;
      }
      return '';
    }).filter(Boolean);
    return `{${pairs.join(', ')}}`;
  }

  visitNumero(node) { return node.valor; }
  visitCadena(node) { return node.valor; }

  visitTemplate(node) {
    const inner = node.valor.slice(1, -1);
    const converted = inner.replace(/\$\{([^}]*)\}/g, (_, expr) => {
      const translated = expr.replace(/\bthis\./g, 'self.');
      return `{${translated}}`;
    });
    return `f"${converted.replace(/"/g, '\\"')}"`;
  }

  visitBooleano(node) { return node.valor === 'true' ? 'True' : 'False'; }
  visitNull() { return 'None'; }
  visitUndefined() { return 'None'; }
  visitThis() { return 'self'; }
  visitSuper() { return 'super()'; }
  visitIdentificador(node) { return node.valor; }
  visitAgrupacion(node) { return `(${this.e(node.hijos[0])})`; }

  // ── Helpers ──────────────────────────────────────────────────────────────────

  _params(paramsNode, addSelf) {
    const parts = addSelf ? ['self'] : [];
    for (const p of (paramsNode && paramsNode.hijos) || []) {
      if (p.tipo === 'Parametro') {
        parts.push(p.hijos[0] ? `${p.valor}=${this.e(p.hijos[0].hijos[0])}` : p.valor);
      } else if (p.tipo === 'ParametroRest') {
        parts.push(`*${p.valor}`);
      }
    }
    return parts.join(', ');
  }

  _args(n) {
    return ((n && n.hijos) || []).map(a =>
      a.tipo === 'Spread' ? `*${this.e(a.hijos[0])}` : this.e(a)
    ).join(', ');
  }

  _body(node) {
    if (!node) { this.depth++; const i = this.ind(); this.depth--; return `${i}pass`; }
    if (node.tipo === 'Bloque') return this.visitBloque(node);
    this.depth++;
    const r = this.visit(node);
    this.depth--;
    if (!r) { this.depth++; const i = this.ind(); this.depth--; return `${i}pass`; }
    return r;
  }

  _bodyLines(node) {
    if (!node) return [];
    if (node.tipo === 'Bloque') {
      this.depth++;
      const lines = (node.hijos || []).map(h => this.visit(h)).filter(Boolean);
      this.depth--;
      return lines;
    }
    this.depth++;
    const r = this.visit(node);
    this.depth--;
    return r ? [r] : [];
  }

  _varName(node) {
    if (!node) return '_';
    if (node.tipo === 'DeclaracionVariable' && node.hijos[0]) return node.hijos[0].valor;
    if (node.tipo === 'Identificador') return node.valor;
    return '_';
  }

  _getType(node) {
    if (!node) return 'unknown';
    switch (node.tipo) {
      case 'Arreglo':  return 'list';
      case 'Objeto':   return 'dict';
      case 'Cadena':   case 'Template': return 'str';
      case 'Numero':   return 'num';
      case 'Booleano': return 'bool';
      case 'AccesoIndice': {
        const obj = node.hijos[0];
        if (obj && obj.tipo === 'Identificador' && this._ti)
          return this._ti.elemTypeOf(obj.valor);
        return 'unknown';
      }
      case 'OperacionBinaria': {
        if (node.valor === '+') {
          const lt = this._getType(node.hijos[0]);
          const rt = this._getType(node.hijos[1]);
          if (lt === 'str' || rt === 'str') return 'str';
          if (lt === 'num' && rt === 'num') return 'num';
        }
        return 'unknown';
      }
      case 'Identificador': return this._ti ? this._ti.typeOf(node.valor) : 'unknown';
      default: return 'unknown';
    }
  }

  _isConsoleLog(callee) {
    return callee && callee.tipo === 'AccesoMiembro' && callee.valor === 'log' &&
           callee.hijos[0] && callee.hijos[0].tipo === 'Identificador' &&
           callee.hijos[0].valor === 'console';
  }

  _tryRange(initN, condN, updN) {
    if (!initN || !condN || !updN) return null;
    let varName = null, startVal = '0';
    if (initN.tipo === 'DeclaracionVariable' && (initN.hijos || []).length === 1) {
      const d = initN.hijos[0];
      if (d && d.tipo === 'Declarador') { varName = d.valor; startVal = d.hijos[0] ? this.e(d.hijos[0]) : '0'; }
    }
    if (!varName || condN.tipo !== 'OperacionBinaria') return null;
    if (!['<', '<='].includes(condN.valor)) return null;
    const cl = condN.hijos[0];
    if (!cl || cl.tipo !== 'Identificador' || cl.valor !== varName) return null;
    const endVal = this.e(condN.hijos[1]);
    const incl = condN.valor === '<=';
    const u = updN;
    let ok = false;
    if ((u.tipo === 'PostIncremento' || u.tipo === 'OperacionUnaria') && u.valor === '++') {
      const op = u.hijos[0];
      if (op && op.tipo === 'Identificador' && op.valor === varName) ok = true;
    }
    if (!ok) return null;
    const end = incl ? `${endVal} + 1` : endVal;
    return startVal === '0' ? `${varName} in range(${end})` : `${varName} in range(${startVal}, ${end})`;
  }

  _updStmt(node) {
    if (!node) return null;
    if ((node.tipo === 'PostIncremento' || node.tipo === 'OperacionUnaria') &&
        (node.valor === '++' || node.valor === '--')) {
      const op = node.valor === '++' ? '+= 1' : '-= 1';
      return `${this.e(node.hijos[0])} ${op}`;
    }
    return this.e(node);
  }
}

// ─── Java ────────────────────────────────────────────────────────────────────

class JavaTranslator extends Translator {
  constructor() {
    super();
    this._currentClass = null;
    this._arrowCount = 0;
  }

  translate(ast) {
    if (!ast) return '';
    const hijos = ast.hijos || [];
    const classes = hijos.filter(h => h.tipo === 'DeclaracionClase');
    const fns = hijos.filter(h => h.tipo === 'DeclaracionFuncion');
    const stmts = hijos.filter(h => h.tipo !== 'DeclaracionClase' && h.tipo !== 'DeclaracionFuncion');

    const parts = [];

    for (const c of classes) {
      this.depth = 0;
      parts.push(this.visit(c));
    }

    const mainLines = [];
    // static helper methods
    for (const fn of fns) {
      this.depth = 1;
      mainLines.push(this.visit(fn));
    }
    // main body
    for (const s of stmts) {
      this.depth = 2;
      mainLines.push(this.visit(s));
    }

    if (mainLines.length || fns.length) {
      const staticMethods = fns.map(fn => { this.depth = 1; return this.visit(fn); }).filter(Boolean);
      const mainStmts = stmts.map(s => { this.depth = 2; return this.visit(s); }).filter(Boolean);
      const block = [
        'public class Main {',
        ...staticMethods,
        '    public static void main(String[] args) {',
        ...mainStmts,
        '    }',
        '}'
      ].filter(Boolean);
      parts.push(block.join('\n'));
    }

    return parts.join('\n\n');
  }

  // ── Statements ──────────────────────────────────────────────────────────────

  visitPrograma(node) {
    return (node.hijos || []).map(h => this.visit(h)).filter(Boolean).join('\n');
  }

  visitDeclaracionVariable(node) {
    const lines = [];
    for (const d of node.hijos) {
      if (d.tipo !== 'Declarador') continue;
      const init = d.hijos[0] ? this.e(d.hijos[0]) : 'null';
      lines.push(`${this.ind()}var ${d.valor} = ${init};`);
    }
    return lines.join('\n');
  }

  visitDeclaracionFuncion(node) {
    const params = this._params(this.ch(node, 0));
    const body = this._body(this.ch(node, 1));
    const ind = this.ind();
    return `${ind}public static Object ${node.valor}(${params}) {\n${body}\n${ind}}`;
  }

  visitDeclaracionClase(node) {
    const hijos = node.hijos || [];
    let base = '', start = 0;
    if (hijos[0] && hijos[0].tipo === 'Extiende') { base = ` extends ${hijos[0].valor}`; start = 1; }
    const ind = this.ind();
    const prev = this._currentClass;
    this._currentClass = node.valor;
    this.depth++;
    const members = hijos.slice(start).map(m => this.visit(m)).filter(Boolean);
    this.depth--;
    this._currentClass = prev;
    const body = members.join('\n');
    return `${ind}public class ${node.valor}${base} {\n${body}\n${ind}}`;
  }

  visitMetodo(node) {
    const rawName = node.valor;
    const isStatic = rawName.startsWith('static ');
    const name = isStatic ? rawName.slice(7) : rawName;
    const params = this._params(node.hijos[0]);
    const body = this._body(node.hijos[1]);
    const ind = this.ind();
    if (name === 'constructor') {
      return `${ind}public ${this._currentClass || 'Object'}(${params}) {\n${body}\n${ind}}`;
    }
    const mod = isStatic ? 'static ' : '';
    return `${ind}public ${mod}Object ${name}(${params}) {\n${body}\n${ind}}`;
  }

  visitCampo(node) {
    const raw = node.valor;
    const isStatic = raw.startsWith('static ');
    const name = isStatic ? raw.slice(7) : raw;
    const init = node.hijos[0] ? this.e(node.hijos[0]) : 'null';
    const mod = isStatic ? 'static ' : '';
    return `${this.ind()}${mod}Object ${name} = ${init};`;
  }

  visitSentenciaIf(node) {
    const [condW, thenW, elseW] = node.hijos;
    const cond = this.e(this.unwrap(condW));
    const ind = this.ind();
    let out = `${ind}if (${cond}) {\n${this._body(this.unwrap(thenW))}\n${ind}}`;
    if (elseW) {
      const en = this.unwrap(elseW);
      if (en && en.tipo === 'SentenciaIf') {
        out += ` else ${this.visit(en).replace(/^\s*/, '')}`;
      } else {
        out += ` else {\n${this._body(en)}\n${ind}}`;
      }
    }
    return out;
  }

  visitSentenciaFor(node) {
    const [initW, condW, updW, bodyW] = node.hijos;
    const initN = this.unwrap(initW), condN = this.unwrap(condW);
    const updN = this.unwrap(updW), bodyN = this.unwrap(bodyW);
    const ind = this.ind();
    const initStr = initN ? this._forInit(initN) : '';
    const condStr = condN ? this.e(condN) : '';
    const updStr = updN ? this.e(updN) : '';
    const body = this._body(bodyN);
    return `${ind}for (${initStr}; ${condStr}; ${updStr}) {\n${body}\n${ind}}`;
  }

  visitSentenciaForIn(node) {
    const [varW, iterW, bodyW] = node.hijos;
    const varN = this.unwrap(varW);
    const varName = varN && varN.hijos[0] ? varN.hijos[0].valor : '_';
    const iter = this.e(this.unwrap(iterW));
    const body = this._body(this.unwrap(bodyW));
    const ind = this.ind();
    return `${ind}for (var ${varName} : ((java.util.Map<?,?>)${iter}).keySet()) {\n${body}\n${ind}}`;
  }

  visitSentenciaForOf(node) {
    const [varW, iterW, bodyW] = node.hijos;
    const varN = this.unwrap(varW);
    const varName = varN && varN.hijos[0] ? varN.hijos[0].valor : '_';
    const iter = this.e(this.unwrap(iterW));
    const body = this._body(this.unwrap(bodyW));
    const ind = this.ind();
    return `${ind}for (var ${varName} : ${iter}) {\n${body}\n${ind}}`;
  }

  visitSentenciaWhile(node) {
    const cond = this.e(this.unwrap(node.hijos[0]));
    const body = this._body(this.unwrap(node.hijos[1]));
    const ind = this.ind();
    return `${ind}while (${cond}) {\n${body}\n${ind}}`;
  }

  visitSentenciaDoWhile(node) {
    const [bodyW, condW] = node.hijos;
    const cond = this.e(this.unwrap(condW));
    const body = this._body(this.unwrap(bodyW));
    const ind = this.ind();
    return `${ind}do {\n${body}\n${ind}} while (${cond});`;
  }

  visitSentenciaSwitch(node) {
    const [discW, ...cases] = node.hijos;
    const disc = this.e(this.unwrap(discW));
    const ind = this.ind();
    const lines = [`${ind}switch (${disc}) {`];
    this.depth++;
    for (const c of cases) {
      if (c.tipo === 'Caso') {
        const val = this.e(this.unwrap(c.hijos[0]));
        lines.push(`${this.ind()}case ${val}:`);
        this.depth++;
        c.hijos.slice(1).forEach(s => { const r = this.visit(s); if (r) lines.push(r); });
        this.depth--;
      } else if (c.tipo === 'CasoDefault') {
        lines.push(`${this.ind()}default:`);
        this.depth++;
        c.hijos.forEach(s => { const r = this.visit(s); if (r) lines.push(r); });
        this.depth--;
      }
    }
    this.depth--;
    lines.push(`${this.ind()}}`);
    return lines.join('\n');
  }

  visitSentenciaReturn(node) {
    const val = node.hijos[0] ? this.e(node.hijos[0]) : null;
    return val ? `${this.ind()}return ${val};` : `${this.ind()}return;`;
  }

  visitSentenciaBreak() { return `${this.ind()}break;`; }
  visitSentenciaContinue() { return `${this.ind()}continue;`; }

  visitSentenciaThrow(node) {
    return `${this.ind()}throw new RuntimeException(String.valueOf(${this.e(node.hijos[0])}));`;
  }

  visitSentenciaTry(node) {
    const [intentarW, ...rest] = node.hijos;
    const ind = this.ind();
    const parts = [`${ind}try {\n${this._body(this.unwrap(intentarW))}\n${ind}}`];
    for (const r of rest) {
      if (r.tipo === 'Catch') {
        const param = r.valor ? r.valor : 'e';
        parts.push(`catch (Exception ${param}) {\n${this._body(r.hijos[0])}\n${ind}}`);
      } else if (r.tipo === 'Finally') {
        parts.push(`finally {\n${this._body(this.unwrap(r))}\n${ind}}`);
      }
    }
    return parts.join(' ');
  }

  visitBloque(node) {
    this.depth++;
    const ss = (node.hijos || []).map(h => this.visit(h)).filter(Boolean);
    this.depth--;
    return ss.join('\n');
  }

  visitSentenciaExpresion(node) {
    return node.hijos[0] ? `${this.ind()}${this.e(node.hijos[0])};` : '';
  }

  // ── Expressions ─────────────────────────────────────────────────────────────

  e(node) { return this.visit(node); }

  visitAsignacion(node) {
    const lhs = this.e(this.unwrap(node.hijos[0]));
    const rhs = this.e(this.unwrap(node.hijos[1]));
    return `${lhs} ${node.valor} ${rhs}`;
  }

  visitTernario(node) {
    const [cW, tW, eW] = node.hijos;
    return `${this.e(this.unwrap(cW))} ? ${this.e(this.unwrap(tW))} : ${this.e(this.unwrap(eW))}`;
  }

  visitOperacionBinaria(node) {
    const l = this.e(node.hijos[0]), r = this.e(node.hijos[1]);
    const op = node.valor;
    if (op === '===' || op === '==') return `${l} == ${r}`;
    if (op === '!==' || op === '!=') return `${l} != ${r}`;
    if (op === '&&') return `${l} && ${r}`;
    if (op === '||') return `${l} || ${r}`;
    if (op === '??') return `(${l} != null ? ${l} : ${r})`;
    if (op === 'instanceof') return `${l} instanceof ${r}`;
    if (op === 'in') return `((java.util.Map<?,?>)${r}).containsKey(${l})`;
    return `${l} ${op} ${r}`;
  }

  visitOperacionUnaria(node) {
    const op = node.valor, o = this.e(node.hijos[0]);
    switch (op) {
      case '!': return `!${o}`;
      case 'typeof': return `${o}.getClass().getName()`;
      case 'void': return `null`;
      case 'delete': return `null /* delete ${o} */`;
      case '++': return `++${o}`;
      case '--': return `--${o}`;
      case 'await': return o;
      default: return `${op}${o}`;
    }
  }

  visitNuevo(node) {
    const inner = node.hijos[0];
    if (inner && inner.tipo === 'Llamada') {
      const callee = this.e(inner.hijos[0]);
      const args = this._args(inner.hijos[1]);
      return `new ${callee}(${args})`;
    }
    return `new ${this.e(inner)}()`;
  }

  visitLlamada(node) {
    const callee = node.hijos[0], argsNode = node.hijos[1];
    const args = this._args(argsNode);
    if (this._isConsoleLog(callee)) return `System.out.println(${args})`;
    return `${this.e(callee)}(${args})`;
  }

  visitAccesoMiembro(node) { return `${this.e(node.hijos[0])}.${node.valor}`; }

  visitAccesoOpcional(node) {
    const obj = this.e(node.hijos[0]);
    return `(${obj} != null ? ${obj}.${node.valor} : null)`;
  }

  visitAccesoIndice(node) {
    return `${this.e(node.hijos[0])}[${this.e(this.unwrap(node.hijos[1]))}]`;
  }

  visitPostIncremento(node) { return `${this.e(node.hijos[0])}${node.valor}`; }

  visitFuncionFlecha(node) {
    const params = this._lambdaParams(node.hijos[0]);
    const body = node.hijos[1];
    if (body && body.tipo === 'Cuerpo') return `(${params}) -> ${this.e(body.hijos[0])}`;
    this.depth++;
    const b = this._body(body);
    this.depth--;
    return `(${params}) -> {\n${b}\n${this.ind()}}`;
  }

  visitFuncionExpr(node) {
    const params = this._lambdaParams(node.hijos[0]);
    const body = node.hijos[1];
    if (body && body.tipo === 'Bloque' && body.hijos.length === 1) {
      const s = body.hijos[0];
      if (s && s.tipo === 'SentenciaReturn' && s.hijos[0]) {
        return `(${params}) -> ${this.e(s.hijos[0])}`;
      }
    }
    return `(${params}) -> { /* function body */ }`;
  }

  visitArreglo(node) {
    const items = (node.hijos || []).map(h =>
      h.tipo === 'Spread' ? this.e(h.hijos[0]) : this.e(h)
    );
    return `java.util.List.of(${items.join(', ')})`;
  }

  visitObjeto(node) {
    const pairs = (node.hijos || []).map(h => {
      if (h.tipo === 'Spread') return `/* ...${this.e(h.hijos[0])} */`;
      if (h.tipo === 'Propiedad') {
        const key = h.valor === '[computada]'
          ? this.e(h.hijos[0] && h.hijos[0].hijos[0])
          : `"${h.valor}"`;
        const val = h.hijos[0]
          ? (h.valor === '[computada]' ? this.e(h.hijos[1] && h.hijos[1].hijos[0]) : this.e(h.hijos[0]))
          : h.valor;
        return `${key}, ${val}`;
      }
      if (h.tipo === 'MetodoObjeto') return `"${h.valor}", null /* method */`;
      return '';
    }).filter(Boolean);
    return `java.util.Map.of(${pairs.join(', ')})`;
  }

  visitNumero(node) { return node.valor; }
  visitCadena(node) { return node.valor; }

  visitTemplate(node) {
    const inner = node.valor.slice(1, -1);
    const parts = [];
    let last = 0;
    const re = /\$\{([^}]*)\}/g;
    let m;
    while ((m = re.exec(inner)) !== null) {
      if (m.index > last) parts.push(JSON.stringify(inner.slice(last, m.index)));
      parts.push(m[1]);
      last = m.index + m[0].length;
    }
    if (last < inner.length) parts.push(JSON.stringify(inner.slice(last)));
    return parts.length ? parts.join(' + ') : '""';
  }

  visitBooleano(node) { return node.valor; }
  visitNull() { return 'null'; }
  visitUndefined() { return 'null'; }
  visitThis() { return 'this'; }
  visitSuper() { return 'super'; }
  visitIdentificador(node) { return node.valor; }
  visitAgrupacion(node) { return `(${this.e(node.hijos[0])})`; }

  // ── Helpers ──────────────────────────────────────────────────────────────────

  _params(paramsNode) {
    const parts = [];
    for (const p of (paramsNode && paramsNode.hijos) || []) {
      if (p.tipo === 'Parametro') {
        parts.push(p.hijos[0] ? `Object ${p.valor} /* = ${this.e(p.hijos[0].hijos[0])} */` : `Object ${p.valor}`);
      } else if (p.tipo === 'ParametroRest') {
        parts.push(`Object... ${p.valor}`);
      }
    }
    return parts.join(', ');
  }

  _args(n) {
    return ((n && n.hijos) || []).map(a =>
      a.tipo === 'Spread' ? this.e(a.hijos[0]) : this.e(a)
    ).join(', ');
  }

  _body(node) {
    if (!node) return '';
    if (node.tipo === 'Bloque') return this.visitBloque(node);
    this.depth++;
    const r = this.visit(node);
    this.depth--;
    return r || '';
  }

  _forInit(node) {
    if (!node) return '';
    if (node.tipo === 'DeclaracionVariable') {
      const lines = [];
      for (const d of node.hijos) {
        if (d.tipo !== 'Declarador') continue;
        const init = d.hijos[0] ? this.e(d.hijos[0]) : 'null';
        lines.push(`var ${d.valor} = ${init}`);
      }
      return lines.join(', ');
    }
    return this.e(node);
  }

  _lambdaParams(paramsNode) {
    const parts = [];
    for (const p of (paramsNode && paramsNode.hijos) || []) {
      if (p.tipo === 'Parametro') parts.push(p.valor);
      else if (p.tipo === 'ParametroRest') parts.push(p.valor + '...');
    }
    return parts.join(', ');
  }

  _isConsoleLog(callee) {
    return callee && callee.tipo === 'AccesoMiembro' && callee.valor === 'log' &&
           callee.hijos[0] && callee.hijos[0].tipo === 'Identificador' &&
           callee.hijos[0].valor === 'console';
  }
}

// ─── Export ──────────────────────────────────────────────────────────────────

function translate(ast, target) {
  if (target === 'python') return new PythonTranslator().translate(ast);
  if (target === 'java') return new JavaTranslator().translate(ast);
  throw new Error('Target no soportado: ' + target);
}

module.exports = { translate };

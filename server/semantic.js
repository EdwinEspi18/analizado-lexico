"use strict";

const BUILTINS = new Set([
  'console', 'Math', 'Array', 'Object', 'String', 'Number', 'Boolean',
  'parseInt', 'parseFloat', 'NaN', 'Infinity',
  'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
  'Promise', 'Error', 'TypeError', 'RangeError', 'ReferenceError',
  'SyntaxError', 'EvalError', 'URIError', 'AggregateError',
  'JSON', 'Date', 'RegExp', 'Map', 'Set', 'WeakMap', 'WeakSet',
  'Symbol', 'Proxy', 'Reflect', 'globalThis', 'window', 'self',
  'document', 'process', 'require', 'module', 'exports',
  '__dirname', '__filename', 'fetch', 'URL', 'URLSearchParams',
  'Event', 'EventTarget', 'arguments', 'eval',
  'isNaN', 'isFinite', 'decodeURI', 'encodeURI',
  'decodeURIComponent', 'encodeURIComponent',
  'ArrayBuffer', 'DataView', 'Int8Array', 'Uint8Array', 'Uint8ClampedArray',
  'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array',
  'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array',
  'BigInt', 'WeakRef', 'FinalizationRegistry', 'queueMicrotask',
  'requestAnimationFrame', 'cancelAnimationFrame',
  'alert', 'confirm', 'prompt', 'location', 'history', 'navigator',
  'performance', 'crypto', 'structuredClone', 'clearImmediate', 'setImmediate',
  'Buffer', 'global',
]);

class Scope {
  constructor(tipo, padre = null) {
    this.tipo = tipo;
    this.padre = padre;
    this.simbolos = new Map();
  }

  buscar(nombre) {
    let s = this;
    while (s) {
      if (s.simbolos.has(nombre)) return s.simbolos.get(nombre);
      s = s.padre;
    }
    return null;
  }
}

function analyze(ast) {
  const tablaSimbolos = [];
  const errores = [];

  const globalScope = new Scope('global');
  BUILTINS.forEach(name => {
    globalScope.simbolos.set(name, { nombre: name, kind: 'builtin', scope: 'global', linea: 0, columna: 0 });
  });

  function addError(mensaje, lexema, linea, columna) {
    errores.push({ mensaje, lexema: lexema || '', linea: linea || 0, columna: columna || 0 });
  }

  function definir(scope, nombre, kind, linea, columna) {
    if (kind === 'var' || kind === 'function' || kind === 'class') {
      // hoist to nearest function/global scope
      let target = scope;
      while (target.tipo === 'bloque' || target.tipo === 'clase') target = target.padre;
      if (target.simbolos.has(nombre)) {
        const prev = target.simbolos.get(nombre);
        // var re-declaration is allowed; redeclaring function/class or over let/const is an error
        if (kind === 'var' && prev.kind === 'var') return;
        if (kind === 'var' && prev.kind === 'builtin') return;
        addError(`Variable ya declarada: '${nombre}'`, nombre, linea, columna);
        return;
      }
      const info = { nombre, kind, scope: target.tipo, linea, columna, usado: false };
      target.simbolos.set(nombre, info);
      tablaSimbolos.push(info);
    } else {
      // let / const / param — block scoped
      if (scope.simbolos.has(nombre)) {
        addError(`Variable ya declarada: '${nombre}'`, nombre, linea, columna);
        return;
      }
      const info = { nombre, kind, scope: scope.tipo, linea, columna, usado: false };
      scope.simbolos.set(nombre, info);
      tablaSimbolos.push(info);
    }
  }

  function inferirTipo(node, scope) {
    if (!node) return 'unknown';
    switch (node.tipo) {
      case 'Numero':   return 'number';
      case 'Cadena':   return 'string';
      case 'Template': return 'string';
      case 'Booleano': return 'boolean';
      case 'Null':     return 'null';
      case 'Undefined':return 'undefined';
      case 'Identificador': {
        const sym = scope.buscar(node.valor);
        return (sym && sym.tipoDato) ? sym.tipoDato : 'unknown';
      }
      case 'Agrupacion':
        return node.hijos[0] ? inferirTipo(node.hijos[0], scope) : 'unknown';
      case 'OperacionBinaria': {
        const t1 = inferirTipo(node.hijos[0], scope);
        const t2 = inferirTipo(node.hijos[1], scope);
        if (['+', '-', '*', '/', '%', '**'].includes(node.valor)) {
          if (node.valor === '+') {
            if (t1 === 'string' || t2 === 'string') return 'string';
            if (t1 === 'number' && t2 === 'number') return 'number';
          } else {
            if (t1 === 'number' && t2 === 'number') return 'number';
          }
        }
        return 'unknown';
      }
      default: return 'unknown';
    }
  }

  function visit(node, scope, ctx) {
    if (!node || typeof node.tipo !== 'string') return;

    switch (node.tipo) {

      case 'Programa':
        for (const h of node.hijos) visit(h, scope, ctx);
        break;

      case 'DeclaracionVariable': {
        const kind = node.valor; // 'var' | 'let' | 'const'
        for (const decl of node.hijos) {
          if (decl.tipo === 'Declarador') {
            definir(scope, decl.valor, kind, decl.line, decl.column);
            if (decl.hijos.length > 0) {
              visit(decl.hijos[0], scope, ctx);
              const sym = scope.buscar(decl.valor);
              if (sym) sym.tipoDato = inferirTipo(decl.hijos[0], scope);
            }
          }
        }
        break;
      }

      case 'DeclaracionFuncion': {
        if (node.valor) definir(scope, node.valor, 'function', node.line, node.column);
        const fnScope = new Scope('funcion', scope);
        const fnCtx = { ...ctx, enFuncion: true, enLoop: false, enSwitch: false };
        for (const h of node.hijos) {
          if (h.tipo === 'Parametros') visitParams(h, fnScope);
          else visit(h, fnScope, fnCtx);
        }
        break;
      }

      case 'FuncionExpr': {
        const fnScope = new Scope('funcion', scope);
        const fnCtx = { ...ctx, enFuncion: true, enLoop: false, enSwitch: false };
        if (node.valor) definir(fnScope, node.valor, 'function', node.line, node.column);
        for (const h of node.hijos) {
          if (h.tipo === 'Parametros') visitParams(h, fnScope);
          else visit(h, fnScope, fnCtx);
        }
        break;
      }

      case 'FuncionFlecha': {
        const fnScope = new Scope('funcion', scope);
        const fnCtx = { ...ctx, enFuncion: true, enLoop: false, enSwitch: false };
        for (const h of node.hijos) {
          if (h.tipo === 'Parametros') visitParams(h, fnScope);
          else visit(h, fnScope, fnCtx);
        }
        break;
      }

      case 'MetodoObjeto': {
        const fnScope = new Scope('funcion', scope);
        const fnCtx = { ...ctx, enFuncion: true, enLoop: false, enSwitch: false };
        for (const h of node.hijos) {
          if (h.tipo === 'Parametros') visitParams(h, fnScope);
          else visit(h, fnScope, fnCtx);
        }
        break;
      }

      case 'DeclaracionClase': {
        if (node.valor) definir(scope, node.valor, 'class', node.line, node.column);
        const clsScope = new Scope('clase', scope);
        for (const h of node.hijos) {
          if (h.tipo === 'Extiende') {
            if (!scope.buscar(h.valor)) {
              addError(`Variable no declarada: '${h.valor}'`, h.valor, h.line, h.column);
            }
          } else {
            visit(h, clsScope, { ...ctx, enFuncion: false });
          }
        }
        break;
      }

      case 'Metodo': {
        const fnScope = new Scope('funcion', scope);
        const fnCtx = { ...ctx, enFuncion: true, enLoop: false, enSwitch: false };
        for (const h of node.hijos) {
          if (h.tipo === 'Parametros') visitParams(h, fnScope);
          else visit(h, fnScope, fnCtx);
        }
        break;
      }

      case 'Bloque': {
        const bloqueScope = new Scope('bloque', scope);
        for (const h of node.hijos) visit(h, bloqueScope, ctx);
        break;
      }

      case 'SentenciaReturn': {
        if (!ctx.enFuncion) {
          addError("return fuera de función", 'return', node.line, node.column);
        }
        for (const h of node.hijos) visit(h, scope, ctx);
        break;
      }

      case 'SentenciaBreak': {
        if (!ctx.enLoop && !ctx.enSwitch) {
          addError("break fuera de bucle o switch", 'break', node.line, node.column);
        }
        break;
      }

      case 'SentenciaContinue': {
        if (!ctx.enLoop) {
          addError("continue fuera de bucle", 'continue', node.line, node.column);
        }
        break;
      }

      case 'SentenciaFor':
      case 'SentenciaForIn':
      case 'SentenciaForOf': {
        const forScope = new Scope('bloque', scope);
        const loopCtx = { ...ctx, enLoop: true };
        for (const h of node.hijos) visit(h, forScope, loopCtx);
        break;
      }

      case 'SentenciaWhile':
      case 'SentenciaDoWhile': {
        const loopCtx = { ...ctx, enLoop: true };
        for (const h of node.hijos) visit(h, scope, loopCtx);
        break;
      }

      case 'SentenciaSwitch': {
        const switchCtx = { ...ctx, enSwitch: true };
        for (const h of node.hijos) visit(h, scope, switchCtx);
        break;
      }

      case 'SentenciaTry': {
        for (const h of node.hijos) {
          if (h.tipo === 'Catch') {
            const catchScope = new Scope('bloque', scope);
            if (h.valor) definir(catchScope, h.valor, 'let', h.line, h.column);
            for (const ch of h.hijos) visit(ch, catchScope, ctx);
          } else {
            visit(h, scope, ctx);
          }
        }
        break;
      }

      case 'Identificador': {
        const sym = scope.buscar(node.valor);
        if (!sym) {
          addError(`Variable no declarada: '${node.valor}'`, node.valor, node.line, node.column);
        } else {
          sym.usado = true;
        }
        break;
      }

      case 'Asignacion': {
        // hijos[0] = Destino wrapper { hijos: [lhs] }, hijos[1] = Valor wrapper { hijos: [rhs] }
        const destWrapper = node.hijos[0];
        const lhs = destWrapper && destWrapper.hijos && destWrapper.hijos[0];
        if (lhs && lhs.tipo === 'Identificador') {
          const sym = scope.buscar(lhs.valor);
          if (!sym) {
            addError(`Variable no declarada: '${lhs.valor}'`, lhs.valor, lhs.line, lhs.column);
          } else if (sym.kind === 'const') {
            addError(`Asignación a constante: '${lhs.valor}'`, lhs.valor, lhs.line, lhs.column);
          }
          if (sym) sym.usado = true;
        } else if (lhs) {
          visit(lhs, scope, ctx);
        }
        if (node.hijos[1]) visit(node.hijos[1], scope, ctx);
        break;
      }

      case 'OperacionBinaria': {
        for (const h of node.hijos) visit(h, scope, ctx);
        const opsArit = new Set(['+', '-', '*', '/', '%', '**']);
        if (opsArit.has(node.valor)) {
          const t1 = inferirTipo(node.hijos[0], scope);
          const t2 = inferirTipo(node.hijos[1], scope);
          if (node.valor === '+') {
            if ((t1 === 'number' && t2 === 'string') || (t1 === 'string' && t2 === 'number')) {
              addError(
                `Mezcla de tipos en '+': '${t1}' y '${t2}'`,
                node.valor, node.line, node.column
              );
            }
          } else {
            if (t1 === 'string' || t2 === 'string') {
              addError(
                `Operación aritmética '${node.valor}' con tipo string`,
                node.valor, node.line, node.column
              );
            }
          }
        }
        break;
      }

      // AccesoMiembro/AccesoOpcional: property name is in valor (not a child), only recurse into object
      case 'AccesoMiembro':
      case 'AccesoOpcional':
        for (const h of node.hijos) visit(h, scope, ctx);
        break;

      default:
        for (const h of node.hijos || []) visit(h, scope, ctx);
        break;
    }
  }

  function visitParams(paramNode, fnScope) {
    const seen = new Set();
    for (const p of paramNode.hijos) {
      const nombre = p.valor;
      if (!nombre) continue;
      if (seen.has(nombre)) {
        addError(`Parámetro duplicado: '${nombre}'`, nombre, p.line, p.column);
      } else {
        seen.add(nombre);
        definir(fnScope, nombre, 'param', p.line, p.column);
      }
    }
  }

  if (ast) {
    visit(ast, globalScope, { enFuncion: false, enLoop: false, enSwitch: false });
  }

  for (const sym of tablaSimbolos) {
    if (!sym.usado) {
      errores.push({
        mensaje: `Variable declarada pero no utilizada: '${sym.nombre}'`,
        lexema: sym.nombre,
        linea: sym.linea,
        columna: sym.columna,
      });
    }
  }

  return { tablaSimbolos, errores };
}

module.exports = { analyze };

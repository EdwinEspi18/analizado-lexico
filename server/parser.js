"use strict";

// Analizador sintactico (parser) de descenso recursivo.
// Consume el flujo de tokens producido por el analizador lexico
// (objetos { type, lexeme, line, column }) y construye un arbol
// sintactico, reportando errores sintacticos con linea/columna.
//
// Exporta parse(tokens) -> { ast, errors }
//   ast    : nodo raiz { tipo, valor?, line?, column?, hijos: [] }
//   errors : [{ message, lexeme, line, column }]  (mismo shape que el lexico)

// --- Conjuntos de tipos de token reutilizados ---

const OPS_ASIGNACION = new Set([
  "OP_ASIG", "OP_ASIG_PLUS", "OP_ASIG_MINUS", "OP_ASIG_MULT", "OP_ASIG_DIV",
  "OP_ASIG_MOD", "OP_ASIG_POW", "OP_ASIG_AND", "OP_ASIG_OR", "OP_ASIG_NUL",
  "OP_ASIG_SHL", "OP_ASIG_SHR", "OP_ASIG_USHR", "OP_ASIG_BAND", "OP_ASIG_BOR",
  "OP_ASIG_XOR",
]);

const UNARIOS = new Set([
  "OP_LOG_NOT", "OP_MINUS", "OP_PLUS", "OP_BNOT", "OP_INCR", "OP_DECR",
  "NR_TYPEOF", "NR_AWAIT", "NR_YIELD",
]);

// Niveles de precedencia binaria, de menor a mayor.
const NIVELES = [
  ["OP_LOG_OR", "OP_NUL_COAL"],
  ["OP_LOG_AND"],
  ["OP_BOR"],
  ["OP_XOR"],
  ["OP_BAND"],
  ["OP_REL_EQ", "OP_REL_NE", "OP_REL_SEQ", "OP_REL_SNE"],
  ["OP_REL_LT", "OP_REL_GT", "OP_REL_LE", "OP_REL_GE", "NR_IN", "NR_INSTANCEOF"],
  ["OP_SHL", "OP_SHR", "OP_USHR"],
  ["OP_PLUS", "OP_MINUS"],
  ["OP_MULT", "OP_DIV", "OP_MOD"],
];

// Tokens que pueden iniciar una sentencia (para sincronizar tras error).
const INICIO_SENTENCIA = new Set([
  "NR_VAR", "NR_LET", "NR_CONST", "NR_FUNCTION", "NR_CLASS", "NR_IF", "NR_FOR",
  "NR_WHILE", "NR_DO", "NR_SWITCH", "NR_RETURN", "NR_BREAK", "NR_CONTINUE",
  "NR_THROW", "NR_TRY",
]);

class ErrorSintactico extends Error {
  constructor(message, token) {
    super(message);
    this.token = token;
  }
}

function parse(tokens) {
  const errors = [];

  // Centinela de fin de entrada.
  const ultimo = tokens.length ? tokens[tokens.length - 1] : { line: 1, column: 1 };
  const eof = { type: "EOF", lexeme: "<fin de entrada>", line: ultimo.line, column: ultimo.column };
  const toks = tokens.concat([eof]);
  let i = 0;

  // --- Helpers del stream ---

  function peek(k = 0) {
    const j = i + k;
    return j < toks.length ? toks[j] : eof;
  }
  function previo() {
    return toks[i - 1];
  }
  function atEnd() {
    return peek().type === "EOF";
  }
  function check(type) {
    return peek().type === type;
  }
  function checkAny(...types) {
    return types.indexOf(peek().type) !== -1;
  }
  function avanzar() {
    const t = peek();
    if (!atEnd()) i++;
    return t;
  }
  function match(...types) {
    if (checkAny(...types)) {
      avanzar();
      return true;
    }
    return false;
  }
  function error(message, token = peek()) {
    errors.push({
      message,
      lexeme: token.lexeme,
      line: token.line,
      column: token.column,
    });
    throw new ErrorSintactico(message, token);
  }
  function esperar(type, message) {
    if (check(type)) return avanzar();
    return error(message);
  }

  function nodo(tipo, props = {}) {
    return Object.assign({ tipo, hijos: [] }, props);
  }
  function envolver(tipo, hijo) {
    const n = nodo(tipo);
    if (hijo) n.hijos.push(hijo);
    return n;
  }

  // Sincronizacion en modo panico: avanza hasta un punto seguro.
  function sincronizar() {
    while (!atEnd()) {
      if (previo() && previo().type === "PUNT_SEMI") return;
      const t = peek().type;
      if (t === "PUNT_RBRACE" || INICIO_SENTENCIA.has(t)) return;
      avanzar();
    }
  }

  // Termina una sentencia: ';' explicito, o insercion automatica antes de '}'/EOF.
  function terminarSentencia() {
    if (match("PUNT_SEMI")) return;
    if (check("PUNT_RBRACE") || atEnd()) return;
    error("Se esperaba ';'");
  }

  // --- Programa y sentencias ---

  function parsePrograma() {
    const prog = nodo("Programa", { line: 1, column: 1 });
    while (!atEnd()) {
      const antes = i;
      try {
        const s = parseSentencia();
        if (s) prog.hijos.push(s);
      } catch (e) {
        if (e instanceof ErrorSintactico) sincronizar();
        else throw e;
      }
      if (i === antes) avanzar(); // evita bucle infinito
    }
    return prog;
  }

  function parseSentencia() {
    switch (peek().type) {
      case "NR_VAR":
      case "NR_LET":
      case "NR_CONST": return parseDeclVar();
      case "NR_FUNCTION": return parseDeclFuncion();
      case "NR_CLASS": return parseDeclClase();
      case "NR_IF": return parseIf();
      case "NR_FOR": return parseFor();
      case "NR_WHILE": return parseWhile();
      case "NR_DO": return parseDoWhile();
      case "NR_SWITCH": return parseSwitch();
      case "NR_RETURN": return parseReturn();
      case "NR_BREAK": return parseSalto("SentenciaBreak");
      case "NR_CONTINUE": return parseSalto("SentenciaContinue");
      case "NR_THROW": return parseThrow();
      case "NR_TRY": return parseTry();
      case "PUNT_LBRACE": return parseBloque();
      case "PUNT_SEMI": avanzar(); return null; // sentencia vacia
      default: return parseSentenciaExpr();
    }
  }

  function parseDeclVarSinFin() {
    const kw = avanzar(); // var / let / const
    const n = nodo("DeclaracionVariable", { valor: kw.lexeme, line: kw.line, column: kw.column });
    do {
      const id = esperar("IDENTIFICADOR", "Se esperaba un identificador");
      const decl = nodo("Declarador", { valor: id.lexeme, line: id.line, column: id.column });
      if (match("OP_ASIG")) decl.hijos.push(parseAsignacion());
      n.hijos.push(decl);
    } while (match("PUNT_COMA"));
    return n;
  }

  function parseDeclVar() {
    const n = parseDeclVarSinFin();
    terminarSentencia();
    return n;
  }

  function parseDeclFuncion() {
    const kw = avanzar();
    const id = esperar("IDENTIFICADOR", "Se esperaba el nombre de la funcion");
    const n = nodo("DeclaracionFuncion", { valor: id.lexeme, line: kw.line, column: kw.column });
    n.hijos.push(parseParametros());
    n.hijos.push(parseBloque());
    return n;
  }

  function parseParametros() {
    esperar("PUNT_LPAREN", "Se esperaba '('");
    const p = nodo("Parametros");
    if (!check("PUNT_RPAREN")) {
      do {
        if (match("OP_SPREAD")) {
          const id = esperar("IDENTIFICADOR", "Se esperaba un identificador");
          p.hijos.push(nodo("ParametroRest", { valor: id.lexeme, line: id.line, column: id.column }));
        } else {
          const id = esperar("IDENTIFICADOR", "Se esperaba un parametro");
          const par = nodo("Parametro", { valor: id.lexeme, line: id.line, column: id.column });
          if (match("OP_ASIG")) par.hijos.push(envolver("Default", parseAsignacion()));
          p.hijos.push(par);
        }
      } while (match("PUNT_COMA"));
    }
    esperar("PUNT_RPAREN", "Se esperaba ')'");
    return p;
  }

  function parseDeclClase() {
    const kw = avanzar();
    const id = esperar("IDENTIFICADOR", "Se esperaba el nombre de la clase");
    const n = nodo("DeclaracionClase", { valor: id.lexeme, line: kw.line, column: kw.column });
    if (match("NR_EXTENDS")) {
      const base = esperar("IDENTIFICADOR", "Se esperaba la superclase");
      n.hijos.push(nodo("Extiende", { valor: base.lexeme, line: base.line, column: base.column }));
    }
    esperar("PUNT_LBRACE", "Se esperaba '{'");
    while (!check("PUNT_RBRACE") && !atEnd()) {
      const antes = i;
      try {
        n.hijos.push(parseMiembroClase());
      } catch (e) {
        if (e instanceof ErrorSintactico) sincronizar();
        else throw e;
      }
      if (i === antes) avanzar();
    }
    esperar("PUNT_RBRACE", "Se esperaba '}'");
    return n;
  }

  function parseMiembroClase() {
    let estatico = false;
    if (check("NR_STATIC")) { estatico = true; avanzar(); }
    const nombre = esperar("IDENTIFICADOR", "Se esperaba el nombre del miembro");
    const etiqueta = (estatico ? "static " : "") + nombre.lexeme;
    if (check("PUNT_LPAREN")) {
      const m = nodo("Metodo", { valor: etiqueta, line: nombre.line, column: nombre.column });
      m.hijos.push(parseParametros());
      m.hijos.push(parseBloque());
      return m;
    }
    const c = nodo("Campo", { valor: etiqueta, line: nombre.line, column: nombre.column });
    if (match("OP_ASIG")) c.hijos.push(parseAsignacion());
    terminarSentencia();
    return c;
  }

  function parseIf() {
    const kw = avanzar();
    const n = nodo("SentenciaIf", { line: kw.line, column: kw.column });
    esperar("PUNT_LPAREN", "Se esperaba '('");
    n.hijos.push(envolver("Condicion", parseExpr()));
    esperar("PUNT_RPAREN", "Se esperaba ')'");
    n.hijos.push(envolver("Entonces", parseSentencia()));
    if (match("NR_ELSE")) n.hijos.push(envolver("Sino", parseSentencia()));
    return n;
  }

  function parseFor() {
    const kw = avanzar();
    const n = nodo("SentenciaFor", { line: kw.line, column: kw.column });
    esperar("PUNT_LPAREN", "Se esperaba '('");

    let init = null;
    if (check("PUNT_SEMI")) {
      // sin inicializacion
    } else if (checkAny("NR_VAR", "NR_LET", "NR_CONST")) {
      init = parseDeclVarSinFin();
    } else {
      init = parseExpr();
    }

    if (checkAny("NR_IN", "NR_OF")) {
      const op = avanzar();
      n.tipo = op.type === "NR_IN" ? "SentenciaForIn" : "SentenciaForOf";
      n.hijos.push(envolver("Variable", init));
      n.hijos.push(envolver("Iterable", parseExpr()));
      esperar("PUNT_RPAREN", "Se esperaba ')'");
      n.hijos.push(envolver("Cuerpo", parseSentencia()));
      return n;
    }

    n.hijos.push(envolver("Inicializacion", init));
    esperar("PUNT_SEMI", "Se esperaba ';'");
    n.hijos.push(envolver("Condicion", check("PUNT_SEMI") ? null : parseExpr()));
    esperar("PUNT_SEMI", "Se esperaba ';'");
    n.hijos.push(envolver("Actualizacion", check("PUNT_RPAREN") ? null : parseExpr()));
    esperar("PUNT_RPAREN", "Se esperaba ')'");
    n.hijos.push(envolver("Cuerpo", parseSentencia()));
    return n;
  }

  function parseWhile() {
    const kw = avanzar();
    const n = nodo("SentenciaWhile", { line: kw.line, column: kw.column });
    esperar("PUNT_LPAREN", "Se esperaba '('");
    n.hijos.push(envolver("Condicion", parseExpr()));
    esperar("PUNT_RPAREN", "Se esperaba ')'");
    n.hijos.push(envolver("Cuerpo", parseSentencia()));
    return n;
  }

  function parseDoWhile() {
    const kw = avanzar();
    const n = nodo("SentenciaDoWhile", { line: kw.line, column: kw.column });
    n.hijos.push(envolver("Cuerpo", parseSentencia()));
    esperar("NR_WHILE", "Se esperaba 'while'");
    esperar("PUNT_LPAREN", "Se esperaba '('");
    n.hijos.push(envolver("Condicion", parseExpr()));
    esperar("PUNT_RPAREN", "Se esperaba ')'");
    terminarSentencia();
    return n;
  }

  function parseSwitch() {
    const kw = avanzar();
    const n = nodo("SentenciaSwitch", { line: kw.line, column: kw.column });
    esperar("PUNT_LPAREN", "Se esperaba '('");
    n.hijos.push(envolver("Discriminante", parseExpr()));
    esperar("PUNT_RPAREN", "Se esperaba ')'");
    esperar("PUNT_LBRACE", "Se esperaba '{'");
    while (!check("PUNT_RBRACE") && !atEnd()) {
      if (check("NR_CASE")) {
        const c = avanzar();
        const caso = nodo("Caso", { line: c.line, column: c.column });
        caso.hijos.push(envolver("Valor", parseExpr()));
        esperar("PUNT_COLON", "Se esperaba ':'");
        while (!checkAny("NR_CASE", "NR_DEFAULT", "PUNT_RBRACE") && !atEnd()) {
          const s = parseSentencia();
          if (s) caso.hijos.push(s);
        }
        n.hijos.push(caso);
      } else if (check("NR_DEFAULT")) {
        const c = avanzar();
        const caso = nodo("CasoDefault", { line: c.line, column: c.column });
        esperar("PUNT_COLON", "Se esperaba ':'");
        while (!checkAny("NR_CASE", "NR_DEFAULT", "PUNT_RBRACE") && !atEnd()) {
          const s = parseSentencia();
          if (s) caso.hijos.push(s);
        }
        n.hijos.push(caso);
      } else {
        avanzar();
      }
    }
    esperar("PUNT_RBRACE", "Se esperaba '}'");
    return n;
  }

  function parseReturn() {
    const kw = avanzar();
    const n = nodo("SentenciaReturn", { line: kw.line, column: kw.column });
    if (!checkAny("PUNT_SEMI", "PUNT_RBRACE") && !atEnd()) n.hijos.push(parseExpr());
    terminarSentencia();
    return n;
  }

  function parseSalto(tipo) {
    const kw = avanzar();
    const n = nodo(tipo, { line: kw.line, column: kw.column });
    if (check("IDENTIFICADOR")) n.valor = avanzar().lexeme; // etiqueta opcional
    terminarSentencia();
    return n;
  }

  function parseThrow() {
    const kw = avanzar();
    const n = nodo("SentenciaThrow", { line: kw.line, column: kw.column });
    n.hijos.push(parseExpr());
    terminarSentencia();
    return n;
  }

  function parseTry() {
    const kw = avanzar();
    const n = nodo("SentenciaTry", { line: kw.line, column: kw.column });
    n.hijos.push(envolver("Intentar", parseBloque()));
    if (match("NR_CATCH")) {
      const c = nodo("Catch");
      if (match("PUNT_LPAREN")) {
        const id = esperar("IDENTIFICADOR", "Se esperaba el parametro de catch");
        c.valor = id.lexeme;
        esperar("PUNT_RPAREN", "Se esperaba ')'");
      }
      c.hijos.push(parseBloque());
      n.hijos.push(c);
    }
    if (match("NR_FINALLY")) n.hijos.push(envolver("Finally", parseBloque()));
    return n;
  }

  function parseBloque() {
    const ll = esperar("PUNT_LBRACE", "Se esperaba '{'");
    const n = nodo("Bloque", { line: ll.line, column: ll.column });
    while (!check("PUNT_RBRACE") && !atEnd()) {
      const antes = i;
      try {
        const s = parseSentencia();
        if (s) n.hijos.push(s);
      } catch (e) {
        if (e instanceof ErrorSintactico) sincronizar();
        else throw e;
      }
      if (i === antes) avanzar();
    }
    esperar("PUNT_RBRACE", "Se esperaba '}'");
    return n;
  }

  function parseSentenciaExpr() {
    const e = parseExpr();
    terminarSentencia();
    return envolver("SentenciaExpresion", e);
  }

  // --- Expresiones ---

  function parseExpr() {
    return parseAsignacion();
  }

  function parseAsignacion() {
    const arrow = intentarArrow();
    if (arrow) return arrow;

    const izq = parseTernario();
    if (OPS_ASIGNACION.has(peek().type)) {
      const op = avanzar();
      const der = parseAsignacion();
      const n = nodo("Asignacion", { valor: op.lexeme, line: op.line, column: op.column });
      n.hijos.push(envolver("Destino", izq));
      n.hijos.push(envolver("Valor", der));
      return n;
    }
    return izq;
  }

  // Devuelve el indice del ')' que cierra el '(' en la posicion `start`, o -1.
  function indiceCierreParen(start) {
    let depth = 0;
    for (let j = start; j < toks.length; j++) {
      const t = toks[j].type;
      if (t === "PUNT_LPAREN") depth++;
      else if (t === "PUNT_RPAREN") {
        depth--;
        if (depth === 0) return j;
      } else if (t === "EOF") break;
    }
    return -1;
  }

  function parseCuerpoFlecha() {
    if (check("PUNT_LBRACE")) return parseBloque();
    return envolver("Cuerpo", parseAsignacion());
  }

  function intentarArrow() {
    // Forma de un parametro: IDENTIFICADOR => ...
    if (check("IDENTIFICADOR") && peek(1).type === "OP_ARROW") {
      const id = avanzar();
      const flecha = avanzar();
      const n = nodo("FuncionFlecha", { line: flecha.line, column: flecha.column });
      const params = nodo("Parametros");
      params.hijos.push(nodo("Parametro", { valor: id.lexeme, line: id.line, column: id.column }));
      n.hijos.push(params);
      n.hijos.push(parseCuerpoFlecha());
      return n;
    }
    // Forma con parentesis: ( params ) => ...
    if (check("PUNT_LPAREN")) {
      const cierre = indiceCierreParen(i);
      if (cierre !== -1 && toks[cierre + 1] && toks[cierre + 1].type === "OP_ARROW") {
        const params = parseParametros();
        const flecha = avanzar(); // OP_ARROW
        const n = nodo("FuncionFlecha", { line: flecha.line, column: flecha.column });
        n.hijos.push(params);
        n.hijos.push(parseCuerpoFlecha());
        return n;
      }
    }
    return null;
  }

  function parseTernario() {
    const cond = parseBinario(0);
    if (check("PUNT_QMARK")) {
      const q = avanzar();
      const n = nodo("Ternario", { line: q.line, column: q.column });
      n.hijos.push(envolver("Condicion", cond));
      n.hijos.push(envolver("SiVerdadero", parseAsignacion()));
      esperar("PUNT_COLON", "Se esperaba ':'");
      n.hijos.push(envolver("SiFalso", parseAsignacion()));
      return n;
    }
    return cond;
  }

  function parseBinario(nivel) {
    if (nivel >= NIVELES.length) return parseExponente();
    let izq = parseBinario(nivel + 1);
    while (NIVELES[nivel].indexOf(peek().type) !== -1) {
      const op = avanzar();
      const der = parseBinario(nivel + 1);
      const n = nodo("OperacionBinaria", { valor: op.lexeme, line: op.line, column: op.column });
      n.hijos.push(izq);
      n.hijos.push(der);
      izq = n;
    }
    return izq;
  }

  function parseExponente() {
    const izq = parseUnario();
    if (check("OP_POW")) {
      const op = avanzar();
      const der = parseExponente(); // asociativo a la derecha
      const n = nodo("OperacionBinaria", { valor: op.lexeme, line: op.line, column: op.column });
      n.hijos.push(izq);
      n.hijos.push(der);
      return n;
    }
    return izq;
  }

  function parseUnario() {
    if (check("NR_NEW")) {
      const kw = avanzar();
      const n = nodo("Nuevo", { line: kw.line, column: kw.column });
      n.hijos.push(parseUnario());
      return n;
    }
    if (UNARIOS.has(peek().type)) {
      const op = avanzar();
      const n = nodo("OperacionUnaria", { valor: op.lexeme, line: op.line, column: op.column });
      n.hijos.push(parseUnario());
      return n;
    }
    return parsePostfijo();
  }

  function parsePostfijo() {
    let exp = parsePrimaria();
    for (;;) {
      if (check("PUNT_DOT")) {
        avanzar();
        const id = esperar("IDENTIFICADOR", "Se esperaba un nombre de propiedad");
        const n = nodo("AccesoMiembro", { valor: id.lexeme, line: id.line, column: id.column });
        n.hijos.push(exp);
        exp = n;
      } else if (check("OP_OPT_CHAIN")) {
        const op = avanzar();
        const id = esperar("IDENTIFICADOR", "Se esperaba un nombre de propiedad");
        const n = nodo("AccesoOpcional", { valor: id.lexeme, line: op.line, column: op.column });
        n.hijos.push(exp);
        exp = n;
      } else if (check("PUNT_LBRACKET")) {
        avanzar();
        const idx = parseExpr();
        esperar("PUNT_RBRACKET", "Se esperaba ']'");
        const n = nodo("AccesoIndice");
        n.hijos.push(exp);
        n.hijos.push(envolver("Indice", idx));
        exp = n;
      } else if (check("PUNT_LPAREN")) {
        const args = parseArgumentos();
        const n = nodo("Llamada");
        n.hijos.push(exp);
        n.hijos.push(args);
        exp = n;
      } else if (checkAny("OP_INCR", "OP_DECR")) {
        const op = avanzar();
        const n = nodo("PostIncremento", { valor: op.lexeme, line: op.line, column: op.column });
        n.hijos.push(exp);
        exp = n;
      } else {
        break;
      }
    }
    return exp;
  }

  function parseArgumentos() {
    esperar("PUNT_LPAREN", "Se esperaba '('");
    const n = nodo("Argumentos");
    if (!check("PUNT_RPAREN")) {
      do {
        if (check("PUNT_RPAREN")) break; // coma final
        if (match("OP_SPREAD")) n.hijos.push(envolver("Spread", parseAsignacion()));
        else n.hijos.push(parseAsignacion());
      } while (match("PUNT_COMA"));
    }
    esperar("PUNT_RPAREN", "Se esperaba ')'");
    return n;
  }

  function parsePrimaria() {
    const t = peek();
    switch (t.type) {
      case "ENTERO":
      case "REAL":
      case "EXP":
      case "HEX":
      case "BIN":
      case "OCT":
        avanzar();
        return nodo("Numero", { valor: t.lexeme, line: t.line, column: t.column });
      case "CADENA":
        avanzar();
        return nodo("Cadena", { valor: t.lexeme, line: t.line, column: t.column });
      case "TEMPLATE_STRING":
        avanzar();
        return nodo("Template", { valor: t.lexeme, line: t.line, column: t.column });
      case "NR_TRUE":
      case "NR_FALSE":
        avanzar();
        return nodo("Booleano", { valor: t.lexeme, line: t.line, column: t.column });
      case "NR_NULL":
        avanzar();
        return nodo("Null", { valor: t.lexeme, line: t.line, column: t.column });
      case "NR_UNDEFINED":
        avanzar();
        return nodo("Undefined", { valor: t.lexeme, line: t.line, column: t.column });
      case "NR_THIS":
        avanzar();
        return nodo("This", { line: t.line, column: t.column });
      case "NR_SUPER":
        avanzar();
        return nodo("Super", { line: t.line, column: t.column });
      case "IDENTIFICADOR":
        avanzar();
        return nodo("Identificador", { valor: t.lexeme, line: t.line, column: t.column });
      case "NR_FUNCTION":
        return parseExprFuncion();
      case "PUNT_LPAREN": {
        avanzar();
        const e = parseExpr();
        esperar("PUNT_RPAREN", "Se esperaba ')'");
        return envolver("Agrupacion", e);
      }
      case "PUNT_LBRACKET":
        return parseArrayLit();
      case "PUNT_LBRACE":
        return parseObjetoLit();
      default:
        return error("Token inesperado", t);
    }
  }

  function parseExprFuncion() {
    const kw = avanzar();
    const n = nodo("FuncionExpr", { line: kw.line, column: kw.column });
    if (check("IDENTIFICADOR")) n.valor = avanzar().lexeme;
    n.hijos.push(parseParametros());
    n.hijos.push(parseBloque());
    return n;
  }

  function parseArrayLit() {
    const lb = avanzar();
    const n = nodo("Arreglo", { line: lb.line, column: lb.column });
    if (!check("PUNT_RBRACKET")) {
      do {
        if (check("PUNT_RBRACKET")) break; // coma final
        if (match("OP_SPREAD")) n.hijos.push(envolver("Spread", parseAsignacion()));
        else n.hijos.push(parseAsignacion());
      } while (match("PUNT_COMA"));
    }
    esperar("PUNT_RBRACKET", "Se esperaba ']'");
    return n;
  }

  function parseObjetoLit() {
    const lb = avanzar();
    const n = nodo("Objeto", { line: lb.line, column: lb.column });
    if (!check("PUNT_RBRACE")) {
      do {
        if (check("PUNT_RBRACE")) break; // coma final
        n.hijos.push(parsePropiedad());
      } while (match("PUNT_COMA"));
    }
    esperar("PUNT_RBRACE", "Se esperaba '}'");
    return n;
  }

  function parsePropiedad() {
    if (match("OP_SPREAD")) return envolver("Spread", parseAsignacion());

    if (check("PUNT_LBRACKET")) {
      avanzar();
      const clave = parseAsignacion();
      esperar("PUNT_RBRACKET", "Se esperaba ']'");
      const p = nodo("Propiedad", { valor: "[computada]" });
      p.hijos.push(envolver("Clave", clave));
      esperar("PUNT_COLON", "Se esperaba ':'");
      p.hijos.push(envolver("Valor", parseAsignacion()));
      return p;
    }

    const llave = peek();
    const esClaveValida =
      checkAny("IDENTIFICADOR", "CADENA", "ENTERO", "REAL") || llave.type.indexOf("NR_") === 0;
    if (!esClaveValida) return error("Se esperaba una propiedad");
    avanzar();

    const p = nodo("Propiedad", { valor: llave.lexeme, line: llave.line, column: llave.column });
    if (match("PUNT_COLON")) {
      p.hijos.push(parseAsignacion());
    } else if (check("PUNT_LPAREN")) {
      p.tipo = "MetodoObjeto";
      p.hijos.push(parseParametros());
      p.hijos.push(parseBloque());
    }
    // si no hay ':' ni '(', es propiedad abreviada { x }
    return p;
  }

  const ast = parsePrograma();
  return { ast, errors };
}

module.exports = { parse };

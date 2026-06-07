%option noyywrap
%option nounput
%option noinput

%{
#include <stdio.h>
#include <string.h>
#include <stdlib.h>

static int g_line = 1;
static int g_col  = 1;
static int tok_line, tok_col;

static char str_buf[16384];
static int  str_len;
static int  str_start_line, str_start_col;
static char str_quote;

static int  comment_start_line, comment_start_col;
static int  tpl_start_line, tpl_start_col;

static void emit_escaped(const char* s, int n) {
    for (int i = 0; i < n; i++) {
        unsigned char c = (unsigned char)s[i];
        switch (c) {
            case '\\': fputs("\\\\", stdout); break;
            case '\t': fputs("\\t",  stdout); break;
            case '\n': fputs("\\n",  stdout); break;
            case '\r': fputs("\\r",  stdout); break;
            default:   fputc(c,      stdout); break;
        }
    }
}

static void emit_token(const char* type) {
    fputs("TOKEN\t", stdout);
    fputs(type, stdout);
    fputc('\t', stdout);
    emit_escaped(yytext, yyleng);
    fprintf(stdout, "\t%d\t%d\n", tok_line, tok_col);
}

static void emit_string_token(void) {
    fputs("TOKEN\tCADENA\t", stdout);
    fputc(str_quote, stdout);
    emit_escaped(str_buf, str_len);
    fputc(str_quote, stdout);
    fprintf(stdout, "\t%d\t%d\n", str_start_line, str_start_col);
}

static void emit_template_token(void) {
    fputs("TOKEN\tTEMPLATE_STRING\t`", stdout);
    emit_escaped(str_buf, str_len);
    fputs("`", stdout);
    fprintf(stdout, "\t%d\t%d\n", tpl_start_line, tpl_start_col);
}

static void emit_error(const char* msg, const char* lex, int n, int line, int col) {
    fputs("ERROR\t", stdout);
    fputs(msg, stdout);
    fputc('\t', stdout);
    emit_escaped(lex, n);
    fprintf(stdout, "\t%d\t%d\n", line, col);
}

#define BEGIN_TOKEN() do { tok_line = g_line; tok_col = g_col; } while (0)
#define ADVANCE()     do { g_col += yyleng; } while (0)
%}

%x STRING
%x BLOCKCOMMENT
%x TEMPLATE

DIGIT    [0-9]
HEXDIG   [0-9a-fA-F]
BINDIG   [01]
OCTDIG   [0-7]
LETTER   [a-zA-Z_$]
IDCHAR   [a-zA-Z_$0-9]

%%

[ \t]+               { g_col += yyleng; }
\r                   { /* skip */ }
\n                   { g_line++; g_col = 1; }

"//"[^\n]*           { g_col += yyleng; }

"/*"                 {
                       comment_start_line = g_line;
                       comment_start_col  = g_col;
                       g_col += 2;
                       BEGIN(BLOCKCOMMENT);
                     }
<BLOCKCOMMENT>"*/"   { g_col += 2; BEGIN(INITIAL); }
<BLOCKCOMMENT>\n     { g_line++; g_col = 1; }
<BLOCKCOMMENT>.      { g_col++; }
<BLOCKCOMMENT><<EOF>> {
                       emit_error("Comentario de bloque sin cerrar", "/*", 2,
                                  comment_start_line, comment_start_col);
                       BEGIN(INITIAL);
                       yyterminate();
                     }

\"                   {
                       str_start_line = g_line;
                       str_start_col  = g_col;
                       str_len = 0;
                       str_quote = '"';
                       g_col++;
                       BEGIN(STRING);
                     }
\'                   {
                       str_start_line = g_line;
                       str_start_col  = g_col;
                       str_len = 0;
                       str_quote = '\'';
                       g_col++;
                       BEGIN(STRING);
                     }
<STRING>\"           {
                       if (str_quote == '"') {
                         g_col++;
                         emit_string_token();
                         BEGIN(INITIAL);
                       } else {
                         if (str_len < 16383) str_buf[str_len++] = '"';
                         g_col++;
                       }
                     }
<STRING>\'           {
                       if (str_quote == '\'') {
                         g_col++;
                         emit_string_token();
                         BEGIN(INITIAL);
                       } else {
                         if (str_len < 16383) str_buf[str_len++] = '\'';
                         g_col++;
                       }
                     }
<STRING>\\n          { if (str_len < 16383) str_buf[str_len++] = '\n'; g_col += 2; }
<STRING>\\t          { if (str_len < 16383) str_buf[str_len++] = '\t'; g_col += 2; }
<STRING>\\r          { if (str_len < 16383) str_buf[str_len++] = '\r'; g_col += 2; }
<STRING>\\\\         { if (str_len < 16383) str_buf[str_len++] = '\\'; g_col += 2; }
<STRING>\\\"         { if (str_len < 16383) str_buf[str_len++] = '"';  g_col += 2; }
<STRING>\\\'         { if (str_len < 16383) str_buf[str_len++] = '\''; g_col += 2; }
<STRING>\\.          { if (str_len < 16383) str_buf[str_len++] = yytext[1]; g_col += 2; }
<STRING>\n           {
                       emit_error("Cadena sin cerrar",
                                  (str_quote == '"' ? "\"" : "'"), 1,
                                  str_start_line, str_start_col);
                       g_line++; g_col = 1;
                       BEGIN(INITIAL);
                     }
<STRING>.            { if (str_len < 16383) str_buf[str_len++] = yytext[0]; g_col++; }
<STRING><<EOF>>      {
                       emit_error("Cadena sin cerrar",
                                  (str_quote == '"' ? "\"" : "'"), 1,
                                  str_start_line, str_start_col);
                       BEGIN(INITIAL);
                       yyterminate();
                     }

\`                   {
                       tpl_start_line = g_line;
                       tpl_start_col  = g_col;
                       str_len = 0;
                       g_col++;
                       BEGIN(TEMPLATE);
                     }
<TEMPLATE>\`         {
                       g_col++;
                       emit_template_token();
                       BEGIN(INITIAL);
                     }
<TEMPLATE>\\.        { if (str_len < 16383) str_buf[str_len++] = yytext[1]; g_col += 2; }
<TEMPLATE>\n         { if (str_len < 16383) str_buf[str_len++] = '\n'; g_line++; g_col = 1; }
<TEMPLATE>.          { if (str_len < 16383) str_buf[str_len++] = yytext[0]; g_col++; }
<TEMPLATE><<EOF>>    {
                       emit_error("Template literal sin cerrar", "`", 1,
                                  tpl_start_line, tpl_start_col);
                       BEGIN(INITIAL);
                       yyterminate();
                     }

"var"                { BEGIN_TOKEN(); emit_token("NR_VAR");        ADVANCE(); }
"let"                { BEGIN_TOKEN(); emit_token("NR_LET");        ADVANCE(); }
"const"              { BEGIN_TOKEN(); emit_token("NR_CONST");      ADVANCE(); }
"function"           { BEGIN_TOKEN(); emit_token("NR_FUNCTION");   ADVANCE(); }
"return"             { BEGIN_TOKEN(); emit_token("NR_RETURN");     ADVANCE(); }
"if"                 { BEGIN_TOKEN(); emit_token("NR_IF");         ADVANCE(); }
"else"               { BEGIN_TOKEN(); emit_token("NR_ELSE");       ADVANCE(); }
"for"                { BEGIN_TOKEN(); emit_token("NR_FOR");        ADVANCE(); }
"while"              { BEGIN_TOKEN(); emit_token("NR_WHILE");      ADVANCE(); }
"do"                 { BEGIN_TOKEN(); emit_token("NR_DO");         ADVANCE(); }
"switch"             { BEGIN_TOKEN(); emit_token("NR_SWITCH");     ADVANCE(); }
"case"               { BEGIN_TOKEN(); emit_token("NR_CASE");       ADVANCE(); }
"default"            { BEGIN_TOKEN(); emit_token("NR_DEFAULT");    ADVANCE(); }
"break"              { BEGIN_TOKEN(); emit_token("NR_BREAK");      ADVANCE(); }
"continue"           { BEGIN_TOKEN(); emit_token("NR_CONTINUE");   ADVANCE(); }
"class"              { BEGIN_TOKEN(); emit_token("NR_CLASS");      ADVANCE(); }
"extends"            { BEGIN_TOKEN(); emit_token("NR_EXTENDS");    ADVANCE(); }
"new"                { BEGIN_TOKEN(); emit_token("NR_NEW");        ADVANCE(); }
"this"               { BEGIN_TOKEN(); emit_token("NR_THIS");       ADVANCE(); }
"super"              { BEGIN_TOKEN(); emit_token("NR_SUPER");      ADVANCE(); }
"static"             { BEGIN_TOKEN(); emit_token("NR_STATIC");     ADVANCE(); }
"null"               { BEGIN_TOKEN(); emit_token("NR_NULL");       ADVANCE(); }
"undefined"          { BEGIN_TOKEN(); emit_token("NR_UNDEFINED");  ADVANCE(); }
"true"               { BEGIN_TOKEN(); emit_token("NR_TRUE");       ADVANCE(); }
"false"              { BEGIN_TOKEN(); emit_token("NR_FALSE");      ADVANCE(); }
"typeof"             { BEGIN_TOKEN(); emit_token("NR_TYPEOF");     ADVANCE(); }
"instanceof"         { BEGIN_TOKEN(); emit_token("NR_INSTANCEOF"); ADVANCE(); }
"in"                 { BEGIN_TOKEN(); emit_token("NR_IN");         ADVANCE(); }
"of"                 { BEGIN_TOKEN(); emit_token("NR_OF");         ADVANCE(); }
"throw"              { BEGIN_TOKEN(); emit_token("NR_THROW");      ADVANCE(); }
"try"                { BEGIN_TOKEN(); emit_token("NR_TRY");        ADVANCE(); }
"catch"              { BEGIN_TOKEN(); emit_token("NR_CATCH");      ADVANCE(); }
"finally"            { BEGIN_TOKEN(); emit_token("NR_FINALLY");    ADVANCE(); }
"import"             { BEGIN_TOKEN(); emit_token("NR_IMPORT");     ADVANCE(); }
"export"             { BEGIN_TOKEN(); emit_token("NR_EXPORT");     ADVANCE(); }
"from"               { BEGIN_TOKEN(); emit_token("NR_FROM");       ADVANCE(); }
"as"                 { BEGIN_TOKEN(); emit_token("NR_AS");         ADVANCE(); }
"async"              { BEGIN_TOKEN(); emit_token("NR_ASYNC");      ADVANCE(); }
"await"              { BEGIN_TOKEN(); emit_token("NR_AWAIT");      ADVANCE(); }
"yield"              { BEGIN_TOKEN(); emit_token("NR_YIELD");      ADVANCE(); }

{LETTER}{IDCHAR}*    { BEGIN_TOKEN(); emit_token("IDENTIFICADOR"); ADVANCE(); }

0[xX]{HEXDIG}+                          { BEGIN_TOKEN(); emit_token("HEX"); ADVANCE(); }
0[bB]{BINDIG}+                          { BEGIN_TOKEN(); emit_token("BIN"); ADVANCE(); }
0[oO]{OCTDIG}+                          { BEGIN_TOKEN(); emit_token("OCT"); ADVANCE(); }
{DIGIT}+"."{DIGIT}+[eE][+-]?{DIGIT}+    { BEGIN_TOKEN(); emit_token("EXP");  ADVANCE(); }
{DIGIT}+[eE][+-]?{DIGIT}+               { BEGIN_TOKEN(); emit_token("EXP");  ADVANCE(); }
{DIGIT}+"."{DIGIT}+                     { BEGIN_TOKEN(); emit_token("REAL"); ADVANCE(); }
{DIGIT}+                                { BEGIN_TOKEN(); emit_token("ENTERO"); ADVANCE(); }

">>>="               { BEGIN_TOKEN(); emit_token("OP_ASIG_USHR");  ADVANCE(); }
">>>"                { BEGIN_TOKEN(); emit_token("OP_USHR");       ADVANCE(); }
"==="                { BEGIN_TOKEN(); emit_token("OP_REL_SEQ");    ADVANCE(); }
"!=="                { BEGIN_TOKEN(); emit_token("OP_REL_SNE");    ADVANCE(); }
"**="                { BEGIN_TOKEN(); emit_token("OP_ASIG_POW");   ADVANCE(); }
"&&="                { BEGIN_TOKEN(); emit_token("OP_ASIG_AND");   ADVANCE(); }
"||="                { BEGIN_TOKEN(); emit_token("OP_ASIG_OR");    ADVANCE(); }
"??="                { BEGIN_TOKEN(); emit_token("OP_ASIG_NUL");   ADVANCE(); }
"<<="                { BEGIN_TOKEN(); emit_token("OP_ASIG_SHL");   ADVANCE(); }
">>="                { BEGIN_TOKEN(); emit_token("OP_ASIG_SHR");   ADVANCE(); }
"..."                { BEGIN_TOKEN(); emit_token("OP_SPREAD");     ADVANCE(); }
"=="                 { BEGIN_TOKEN(); emit_token("OP_REL_EQ");     ADVANCE(); }
"!="                 { BEGIN_TOKEN(); emit_token("OP_REL_NE");     ADVANCE(); }
"<="                 { BEGIN_TOKEN(); emit_token("OP_REL_LE");     ADVANCE(); }
">="                 { BEGIN_TOKEN(); emit_token("OP_REL_GE");     ADVANCE(); }
"=>"                 { BEGIN_TOKEN(); emit_token("OP_ARROW");      ADVANCE(); }
"&&"                 { BEGIN_TOKEN(); emit_token("OP_LOG_AND");    ADVANCE(); }
"||"                 { BEGIN_TOKEN(); emit_token("OP_LOG_OR");     ADVANCE(); }
"??"                 { BEGIN_TOKEN(); emit_token("OP_NUL_COAL");   ADVANCE(); }
"?."                 { BEGIN_TOKEN(); emit_token("OP_OPT_CHAIN");  ADVANCE(); }
"++"                 { BEGIN_TOKEN(); emit_token("OP_INCR");       ADVANCE(); }
"--"                 { BEGIN_TOKEN(); emit_token("OP_DECR");       ADVANCE(); }
"**"                 { BEGIN_TOKEN(); emit_token("OP_POW");        ADVANCE(); }
"<<"                 { BEGIN_TOKEN(); emit_token("OP_SHL");        ADVANCE(); }
">>"                 { BEGIN_TOKEN(); emit_token("OP_SHR");        ADVANCE(); }
"+="                 { BEGIN_TOKEN(); emit_token("OP_ASIG_PLUS");  ADVANCE(); }
"-="                 { BEGIN_TOKEN(); emit_token("OP_ASIG_MINUS"); ADVANCE(); }
"*="                 { BEGIN_TOKEN(); emit_token("OP_ASIG_MULT");  ADVANCE(); }
"/="                 { BEGIN_TOKEN(); emit_token("OP_ASIG_DIV");   ADVANCE(); }
"%="                 { BEGIN_TOKEN(); emit_token("OP_ASIG_MOD");   ADVANCE(); }
"&="                 { BEGIN_TOKEN(); emit_token("OP_ASIG_BAND");  ADVANCE(); }
"|="                 { BEGIN_TOKEN(); emit_token("OP_ASIG_BOR");   ADVANCE(); }
"^="                 { BEGIN_TOKEN(); emit_token("OP_ASIG_XOR");   ADVANCE(); }
"="                  { BEGIN_TOKEN(); emit_token("OP_ASIG");       ADVANCE(); }
"+"                  { BEGIN_TOKEN(); emit_token("OP_PLUS");       ADVANCE(); }
"-"                  { BEGIN_TOKEN(); emit_token("OP_MINUS");      ADVANCE(); }
"*"                  { BEGIN_TOKEN(); emit_token("OP_MULT");       ADVANCE(); }
"/"                  { BEGIN_TOKEN(); emit_token("OP_DIV");        ADVANCE(); }
"%"                  { BEGIN_TOKEN(); emit_token("OP_MOD");        ADVANCE(); }
"!"                  { BEGIN_TOKEN(); emit_token("OP_LOG_NOT");    ADVANCE(); }
"~"                  { BEGIN_TOKEN(); emit_token("OP_BNOT");       ADVANCE(); }
"&"                  { BEGIN_TOKEN(); emit_token("OP_BAND");       ADVANCE(); }
"|"                  { BEGIN_TOKEN(); emit_token("OP_BOR");        ADVANCE(); }
"^"                  { BEGIN_TOKEN(); emit_token("OP_XOR");        ADVANCE(); }
"<"                  { BEGIN_TOKEN(); emit_token("OP_REL_LT");     ADVANCE(); }
">"                  { BEGIN_TOKEN(); emit_token("OP_REL_GT");     ADVANCE(); }

";"                  { BEGIN_TOKEN(); emit_token("PUNT_SEMI");     ADVANCE(); }
","                  { BEGIN_TOKEN(); emit_token("PUNT_COMA");     ADVANCE(); }
"."                  { BEGIN_TOKEN(); emit_token("PUNT_DOT");      ADVANCE(); }
"?"                  { BEGIN_TOKEN(); emit_token("PUNT_QMARK");    ADVANCE(); }
":"                  { BEGIN_TOKEN(); emit_token("PUNT_COLON");    ADVANCE(); }
"("                  { BEGIN_TOKEN(); emit_token("PUNT_LPAREN");   ADVANCE(); }
")"                  { BEGIN_TOKEN(); emit_token("PUNT_RPAREN");   ADVANCE(); }
"{"                  { BEGIN_TOKEN(); emit_token("PUNT_LBRACE");   ADVANCE(); }
"}"                  { BEGIN_TOKEN(); emit_token("PUNT_RBRACE");   ADVANCE(); }
"["                  { BEGIN_TOKEN(); emit_token("PUNT_LBRACKET"); ADVANCE(); }
"]"                  { BEGIN_TOKEN(); emit_token("PUNT_RBRACKET"); ADVANCE(); }

.                    { BEGIN_TOKEN(); emit_error("Caracter no reconocido", yytext, yyleng, tok_line, tok_col); ADVANCE(); }

%%

int main(void) {
    yylex();
    return 0;
}

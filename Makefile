all: lexer-bin dist/lexer

archivo-c: lexer/lexer.l
	flex -o lexer/lex.yy.c lexer/lexer.l

lexer-bin: archivo-c
	gcc -O2 -Wall -Wno-unused-function -o lexer/lexer lexer/lex.yy.c

dist/lexer: lexer-bin
	mkdir -p dist
	cp lexer/lexer dist/lexer

clean:
	rm -f lexer/lex.yy.c lexer/lexer dist/lexer

.PHONY: all clean archivo-c lexer-bin

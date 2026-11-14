# Builds Scintilla + Lexilla (from the Notepad++ source tree) and the web
# platform layer into docs/npp.js + docs/npp.wasm.
#
#   make NPP=/path/to/notepad-plus-plus

NPP      ?= ../npp
SCI      := $(NPP)/scintilla
LEX      := $(NPP)/lexilla
OUT      ?= docs
BUILD    := build

CXX      := emcc
CXXFLAGS := -std=c++17 -O2 -fwasm-exceptions -DNDEBUG -DPTRDIFF_DOESNT_ALIAS_INT \
            -I$(SCI)/include -I$(SCI)/src -I$(LEX)/include -I$(LEX)/lexlib -Isrc/stub

SCI_SRC  := $(wildcard $(SCI)/src/*.cxx)
LEX_SRC  := $(wildcard $(LEX)/lexlib/*.cxx) $(wildcard $(LEX)/lexers/*.cxx) $(LEX)/src/Lexilla.cxx
WEB_SRC  := src/ScintillaWeb.cxx

OBJS := $(patsubst $(SCI)/src/%.cxx,$(BUILD)/sci/%.o,$(SCI_SRC)) \
        $(patsubst $(LEX)/%.cxx,$(BUILD)/lex/%.o,$(LEX_SRC)) \
        $(BUILD)/web/ScintillaWeb.o

LDFLAGS := -O2 -fwasm-exceptions -s MODULARIZE=1 -s EXPORT_NAME=createNppModule -s ENVIRONMENT=web \
           -s ALLOW_MEMORY_GROWTH=1 -s INITIAL_MEMORY=33554432 -s TOTAL_STACK=1048576 \
           -s EXPORTED_FUNCTIONS=_malloc,_free \
           -s EXPORTED_RUNTIME_METHODS=UTF8ToString,stringToUTF8,lengthBytesUTF8,HEAPU8,HEAP32,HEAPF64 \
           --js-library src/library_sci.js --pre-js src/sciplat.js

all: $(OUT)/npp.js assets

# Data taken from the Notepad++ tree: message constants, icons, langs/stylers/themes, versions
assets:
	python3 tools/gen_consts.py $(NPP) $(OUT)/js/sci-consts.js
	python3 tools/extract_assets.py $(NPP) $(OUT)
	python3 tools/gen_version.py $(NPP) $(OUT)/js/version.js
	touch $(OUT)/.nojekyll

$(OUT)/npp.js: $(OBJS) src/library_sci.js src/sciplat.js
	@mkdir -p $(OUT)
	@echo "linking $@"
	@$(CXX) $(OBJS) $(LDFLAGS) -o $@

$(BUILD)/sci/%.o: $(SCI)/src/%.cxx
	@mkdir -p $(dir $@)
	$(CXX) $(CXXFLAGS) -c $< -o $@

$(BUILD)/lex/%.o: $(LEX)/%.cxx
	@mkdir -p $(dir $@)
	$(CXX) $(CXXFLAGS) -c $< -o $@

$(BUILD)/web/%.o: src/%.cxx
	@mkdir -p $(dir $@)
	$(CXX) $(CXXFLAGS) -c $< -o $@

serve:
	cd $(OUT) && python3 -m http.server 8000

test:
	python3 test/functional.py $(OUT)

clean:
	rm -rf $(BUILD) $(OUT)/npp.js $(OUT)/npp.wasm

.PHONY: all assets serve test clean

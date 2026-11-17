mkpkg () 
{ 
    local dir="packages/$1";
    mkdir -p "$dir/src" "$dir/test";
    cat > "$dir/package.json" <<EOF
{
  "name": "@lotseai/$1",
  "version": "0.1.0",
  "description": "$2",
  "license": "Apache-2.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "files": ["dist", "!dist/**/*.tsbuildinfo"],
  "engines": {
    "node": ">=22.12.0"
  },
  "scripts": {
    "build": "tsc -b"
  },
  "dependencies": $3
}
EOF

    local refs=""
    for r in $4;
    do
        refs="$refs{ \"path\": \"../$r\" }, ";
    done;
    refs="${refs%, }";
    cat > "$dir/tsconfig.json" <<EOF
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src"],
  "references": [$refs]
}
EOF

}

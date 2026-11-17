{
  "name": "lotse-adapter-__ID__",
  "version": "0.1.0",
  "description": "Lotse hosting adapter for __DISPLAY__",
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
  "files": ["dist"],
  "keywords": ["lotse", "lotse-adapter"],
  "engines": {
    "node": ">=22.12.0"
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run"
  },
  "dependencies": {
    "@lotse/core": "^__CORE_VERSION__"
  },
  "devDependencies": {
    "@lotse/adapter-testkit": "^__CORE_VERSION__",
    "@types/node": "^22.19.0",
    "typescript": "^7.0.2",
    "vitest": "^5.1.0"
  }
}

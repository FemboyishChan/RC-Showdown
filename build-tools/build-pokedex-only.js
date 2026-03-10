#!/usr/bin/env node
'use strict';

const fs = require("fs");
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
process.chdir(rootDir);

console.log("Loading Pokedex from local server...");

function es3stringify(obj) {
	const buf = JSON.stringify(obj);
	return buf.replace(/"([A-Za-z][A-Za-z0-9]*)":/g, (fullMatch, key) => (
		['return', 'new', 'delete'].includes(key) ? fullMatch : `${key}:`
	));
}

// Load Dex
const Dex = require('../caches/pokemon-showdown/dist/sim/dex').Dex;

// Load Pokedex
const Pokedex = require('../caches/pokemon-showdown/dist/data/pokedex.js').Pokedex;

// Merge in FormatsData
for (const id in Pokedex) {
	const entry = Pokedex[id];
	if (Dex.data.FormatsData[id]) {
		const formatsEntry = Dex.data.FormatsData[id];
		if (formatsEntry.tier) entry.tier = formatsEntry.tier;
		if (formatsEntry.isNonstandard) entry.isNonstandard = formatsEntry.isNonstandard;
		if (formatsEntry.unreleasedHidden) entry.unreleasedHidden = formatsEntry.unreleasedHidden;
	}
}

// Write files
const buf = 'exports.BattlePokedex = ' + es3stringify(Pokedex) + ';';
fs.writeFileSync('play.pokemonshowdown.com/data/pokedex.js', buf);
fs.writeFileSync('play.pokemonshowdown.com/data/pokedex.json', JSON.stringify(Pokedex));

console.log("Generated pokedex.js and pokedex.json");

// Also generate moves.js
const Moves = require('../caches/pokemon-showdown/dist/data/moves.js').Moves;
for (const id in Moves) {
	const move = Dex.moves.get(Moves[id].name);
	if (move.desc) Moves[id].desc = move.desc;
	if (move.shortDesc) Moves[id].shortDesc = move.shortDesc;
	if (move.basePowerCallback) Moves[id].basePowerCallback = true;
}
fs.writeFileSync('play.pokemonshowdown.com/data/moves.js', 'exports.BattleMovedex = ' + es3stringify(Moves) + ';');
fs.writeFileSync('play.pokemonshowdown.com/data/moves.json', JSON.stringify(Moves));
console.log("Generated moves.js");

// Items
const Items = require('../caches/pokemon-showdown/dist/data/items.js').Items;
for (const id in Items) {
	const item = Dex.items.get(Items[id].name);
	if (item.desc) Items[id].desc = item.desc;
	if (item.shortDesc) Items[id].shortDesc = item.shortDesc;
}
fs.writeFileSync('play.pokemonshowdown.com/data/items.js', 'exports.BattleItems = ' + es3stringify(Items) + ';');
console.log("Generated items.js");

// Abilities
const Abilities = require('../caches/pokemon-showdown/dist/data/abilities.js').Abilities;
for (const id in Abilities) {
	const ability = Dex.abilities.get(Abilities[id].name);
	if (ability.desc) Abilities[id].desc = ability.desc;
	if (ability.shortDesc) Abilities[id].shortDesc = ability.shortDesc;
}
fs.writeFileSync('play.pokemonshowdown.com/data/abilities.js', 'exports.BattleAbilities = ' + es3stringify(Abilities) + ';');
console.log("Generated abilities.js");

// Typechart
const TypeChart = require('../caches/pokemon-showdown/dist/data/typechart.js').TypeChart;
fs.writeFileSync('play.pokemonshowdown.com/data/typechart.js', 'exports.BattleTypeChart = ' + es3stringify(TypeChart) + ';');
console.log("Generated typechart.js");

console.log("\nDone! Core data files generated.");

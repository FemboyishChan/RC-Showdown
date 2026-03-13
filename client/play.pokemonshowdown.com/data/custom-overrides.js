/**
 * RC Showdown custom client-side data overrides.
 * Patches BattlePokedex and BattleMovedex after the official CDN data loads,
 * so the teambuilder reflects server-side custom changes without a full rebuild.
 */
(function () {
	// -------------------------------------------------------------------------
	// Decidueye – replace Tinted Lens (slot 1) with Wind Rider
	// -------------------------------------------------------------------------
	if (window.BattlePokedex && BattlePokedex['decidueye']) {
		BattlePokedex['decidueye'].abilities = Object.assign(
			{}, BattlePokedex['decidueye'].abilities, { '1': 'Wind Rider' }
		);
	}

	// -------------------------------------------------------------------------
	// Decidueye-Hisui – replace Tinted Lens (slot 1) with Big Pecks
	// -------------------------------------------------------------------------
	if (window.BattlePokedex && BattlePokedex['decidueyehisui']) {
		BattlePokedex['decidueyehisui'].abilities = Object.assign(
			{}, BattlePokedex['decidueyehisui'].abilities, { '1': 'Big Pecks' }
		);
	}

	// -------------------------------------------------------------------------
	// Raichu-Mega-Y – ensure tier shows as Uber in teambuilder
	// -------------------------------------------------------------------------
	if (window.BattlePokedex) {
		if (!BattlePokedex['raichumegay']) {
			BattlePokedex['raichumegay'] = {};
		}
		BattlePokedex['raichumegay'] = Object.assign({}, BattlePokedex['raichumegay'], {
			tier: 'Uber',
		});
	}

	// -------------------------------------------------------------------------
	// Light of Ruin – mark as obtainable in NatDex (remove isNonstandard flag)
	// -------------------------------------------------------------------------
	if (window.BattleMovedex && BattleMovedex['lightofruin']) {
		delete BattleMovedex['lightofruin'].isNonstandard;
	}
})();

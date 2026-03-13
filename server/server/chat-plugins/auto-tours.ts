/**
 * Auto Tournaments Plugin
 * Automatically creates round-robin tournaments in the lobby every hour,
 * cycling through RC OU, RC UU, VGC Reg A, and VGC Reg B formats.
 * Each tournament has a 15-minute registration window.
 * If fewer than 4 players sign up, the tournament is cancelled and the next
 * one is scheduled in 1 hour.
 * The winner of each tournament receives 1 Avalugg Token.
 * After each tournament, a top-5 Avalugg Token leaderboard is shown.
 *
 * Commands:
 *   /autotour on       - Enable auto tournaments in the current room
 *   /autotour off      - Disable auto tournaments in the current room
 *   /autotour status   - Show current auto tournament status
 *   /autotour next     - Force-start the next scheduled tournament now
 *   /autotour skip     - Skip to the next format in rotation
 *   /avalugg           - View your Avalugg Token count
 *   /avalugg top       - View the top 5 Avalugg Token leaderboard
 *   /avalugg give      - (Admin) Give tokens to a user
 *   /avalugg take      - (Admin) Remove tokens from a user
 *
 * @author Roria Team
 */

import { FS, Utils } from '../../lib';
import type { Tournament as TournamentType } from '../tournaments';

const TOUR_INTERVAL = 60 * 60 * 1000; // 1 hour between tournaments
const SIGNUP_DURATION = 15 * 60 * 1000; // 15 minutes for registration
const AUTODQ_TIMEOUT = 2 * 60 * 1000; // 2 minutes auto-disqualify timer
const MIN_PLAYERS = 4; // minimum players required to start a tournament

const TOKENS_FILE = 'config/chat-plugins/avalugg-tokens.json';

/**
 * The format rotation. These names must match your formats.ts entries exactly.
 */
const TOUR_FORMATS = [
	'[Gen 9] NatDex RC OU',
	'[Gen 9] NatDex RC UU',
	'[Gen 9] NatDex RC Ubers',
	'[Gen 9] NatDex RC VGC 2026 Reg A',
	'[Gen 9] NatDex RC VGC 2026 Reg B',
	'[Gen 9] NatDex RC VGC 2026 Reg C',
];

/** Friendly display names for lobby announcements */
const FORMAT_DISPLAY_NAMES: Record<string, string> = {
	'[Gen 9] NatDex RC OU': 'RC OU',
	'[Gen 9] NatDex RC UU': 'RC UU',
	'[Gen 9] NatDex RC Ubers': 'RC Ubers',
	'[Gen 9] NatDex RC VGC 2026 Reg A': 'RC VGC Reg A',
	'[Gen 9] NatDex RC VGC 2026 Reg B': 'RC VGC Reg B',
	'[Gen 9] NatDex RC VGC 2026 Reg C': 'RC VGC Reg C',
};

/*********************************************************
 * Avalugg Token System
 *********************************************************/

/** userid -> token count */
let tokenData: Record<string, number> = {};

try {
	const raw = FS(TOKENS_FILE).readSync();
	tokenData = JSON.parse(raw);
} catch {
	tokenData = {};
}

function saveTokens() {
	FS(TOKENS_FILE).writeUpdate(() => JSON.stringify(tokenData));
}

function getTokens(userid: ID): number {
	return tokenData[userid] || 0;
}

function addTokens(userid: ID, amount: number) {
	if (!tokenData[userid]) tokenData[userid] = 0;
	tokenData[userid] += amount;
	if (tokenData[userid] <= 0) delete tokenData[userid];
	saveTokens();
}

function getTopTokenHolders(count: number): { userid: string, tokens: number }[] {
	return Object.entries(tokenData)
		.map(([userid, tokens]) => ({ userid, tokens }))
		.sort((a, b) => b.tokens - a.tokens)
		.slice(0, count);
}

function formatLeaderboard(room: BasicRoom): string {
	const top = getTopTokenHolders(5);
	if (!top.length) return '';

	const medals = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣'];
	let buf = `<div class="infobox"><strong>❄️ Avalugg Token Leaderboard</strong><br /><br />`;
	for (let i = 0; i < top.length; i++) {
		const entry = top[i];
		const username = entry.userid;
		buf += `${medals[i]} <strong>${Utils.escapeHTML(username)}</strong> — ${entry.tokens} token${entry.tokens !== 1 ? 's' : ''}<br />`;
	}
	buf += `</div>`;
	return buf;
}

/*********************************************************
 * Auto Tour State
 *********************************************************/

interface AutoTourState {
	/** Index into TOUR_FORMATS for the next tournament */
	formatIndex: number;
	/** Whether auto tours are enabled */
	enabled: boolean;
}

/** In-memory timer handles per room */
const timers = new Map<RoomID, NodeJS.Timeout>();
/** In-memory state per room */
const stateMap = new Map<RoomID, AutoTourState>();

function getState(room: BasicRoom): AutoTourState {
	let s = stateMap.get(room.roomid);
	if (!s) {
		const saved = (room.settings as any).autoTour as AutoTourState | undefined;
		s = saved ? { ...saved } : { formatIndex: 0, enabled: false };
		stateMap.set(room.roomid, s);
	}
	return s;
}

function saveState(room: BasicRoom) {
	const s = getState(room);
	(room.settings as any).autoTour = { formatIndex: s.formatIndex, enabled: s.enabled };
	room.saveSettings();
}

function getNextFormatName(room: BasicRoom): string {
	const s = getState(room);
	return TOUR_FORMATS[s.formatIndex % TOUR_FORMATS.length];
}

function advanceFormat(room: BasicRoom) {
	const s = getState(room);
	s.formatIndex = (s.formatIndex + 1) % TOUR_FORMATS.length;
	saveState(room);
}

/*********************************************************
 * Tournament Winner Hook (monkey-patches onTournamentEnd)
 *********************************************************/

function patchTournamentEnd(tour: TournamentType, room: BasicRoom) {
	const originalEnd = tour.onTournamentEnd.bind(tour);
	tour.onTournamentEnd = function () {
		// Extract winner before the tournament is destroyed
		try {
			const results = (tour.generator.getResults() as any[][]).map(
				(players: any[]) => players.map((p: any) => p.name)
			);
			const winners: string[] = results[0] || [];

			// Award 1 Avalugg Token to each winner (ties possible in round-robin)
			for (const winnerName of winners) {
				const winnerId = toID(winnerName);
				addTokens(winnerId, 1);

				room.add(
					`|html|<div class="broadcast-blue">` +
					`<strong>❄️ ${Utils.escapeHTML(winnerName)}</strong> earned 1 Avalugg Token for winning the tournament! ` +
					`(Total: ${getTokens(winnerId)})` +
					`</div>`
				);
			}

			// Show leaderboard
			const lb = formatLeaderboard(room);
			if (lb) room.add(`|html|${lb}`);
			room.update();
		} catch (e: any) {
			room.add(`|html|<div class="broadcast-red">Error awarding tokens: ${Utils.escapeHTML(e.message)}</div>`);
			room.update();
		}

		// Call the original onTournamentEnd
		originalEnd();
	};
}

/*********************************************************
 * Min-Player Patch for built-in autostart
 *********************************************************/

function patchMinPlayers(tour: TournamentType, room: BasicRoom) {
	const originalStart = tour.startTournament.bind(tour);
	(tour as any).startTournament = function (output: any, isAutostart?: boolean): boolean {
		if (isAutostart && tour.players.length < MIN_PLAYERS) {
			const displayName = FORMAT_DISPLAY_NAMES[(tour as any).name] || (tour as any).name;
			room.add(
				`|html|<div class="broadcast-red"><strong>` +
				`Auto Tournament Cancelled:</strong> ${Utils.escapeHTML(displayName)} — ` +
				`only ${tour.players.length} player${tour.players.length !== 1 ? 's' : ''} signed up ` +
				`(need at least ${MIN_PLAYERS}). Next tournament in 1 hour.` +
				`</div>`
			);
			room.update();
			(tour as any).forceEnd();
			scheduleNext(room);
			return false;
		}
		return originalStart(output, isAutostart);
	};
}

/*********************************************************
 * Core Logic
 *********************************************************/

function makeFakeContext(room: BasicRoom) {
	return {
		sendReply(msg: string) {
			room.add(`|html|<div class="broadcast-red">${Utils.escapeHTML(msg)}</div>`);
			room.update();
		},
		errorReply(msg: string) {
			room.add(`|html|<div class="broadcast-red">${Utils.escapeHTML(msg)}</div>`);
			room.update();
		},
		parse(msg: string) { },
		checkChat(msg: string) { return msg; },
		modlog() { },
		privateModAction() { },
	} as any;
}

function createAutoTournament(room: BasicRoom) {
	const s = getState(room);
	if (!s.enabled) return;

	// Don't create if there's already a game/tournament running
	if (room.game) {
		scheduleRetry(room, 5 * 60 * 1000);
		return;
	}

	if (Rooms.global.lockdown) {
		scheduleRetry(room, 5 * 60 * 1000);
		return;
	}

	const formatName = getNextFormatName(room);
	const format = Dex.formats.get(formatName);

	if (format.effectType !== 'Format' || !format.tournamentShow) {
		room.add(`|html|<div class="broadcast-red"><strong>Auto Tournament Error:</strong> Format "${formatName}" is not a valid tournament format. Skipping.</div>`);
		room.update();
		advanceFormat(room);
		scheduleNext(room);
		return;
	}

	const displayName = FORMAT_DISPLAY_NAMES[formatName] || formatName;

	try {
		const { Tournaments } = require('../tournaments') as typeof import('../tournaments');
		const fakeContext = makeFakeContext(room);

		const tour = Tournaments.createTournament(
			room as any,       // room
			formatName,        // format
			'roundrobin',      // generator type (round-robin!)
			undefined,         // player cap (no cap)
			false,             // isRated
			undefined,         // generator modifier
			undefined,         // custom name
			fakeContext         // output context
		);

		if (tour) {
			// Patch startTournament to enforce minimum player count on autostart
			patchMinPlayers(tour, room);

			// Use the built-in autostart timer (15 min signup window)
			tour.setAutoStartTimeout(SIGNUP_DURATION, fakeContext);

			// Set auto-disqualify timer for idle players (applied after start)
			tour.setAutoDisqualifyTimeout(AUTODQ_TIMEOUT, fakeContext);
			// Force timer on
			tour.setForceTimer(true);

			// Monkey-patch onTournamentEnd to award Avalugg Tokens + show leaderboard
			patchTournamentEnd(tour, room);

			// Announce the tournament with the signup timer info
			room.add(
				`|html|<div class="broadcast-green"><strong>` +
				`&#127942; Auto Tournament: ${Utils.escapeHTML(displayName)} (Round Robin)</strong><br />` +
				`Registration is open for 15 minutes! Use <code>/tour join</code> to enter.<br />` +
				`<small>Minimum ${MIN_PLAYERS} players required or the tournament will be cancelled.</small>` +
				`</div>`
			);
			room.update();

			advanceFormat(room);
		}
	} catch (e: any) {
		room.add(`|html|<div class="broadcast-red"><strong>Auto Tournament Error:</strong> ${Utils.escapeHTML(e.message)}</div>`);
		room.update();
		advanceFormat(room);
	}

	// Note: scheduleNext is NOT called here — it is called either:
	// - After the signup timer cancels the tour (not enough players)
	// - After the tournament ends naturally (via the patched onTournamentEnd -> remove -> game clears)
	// We schedule the next one after the current tour concludes, not immediately.
	// Actually, schedule it now so there's always a next one queued.
	scheduleNext(room);
}

function scheduleNext(room: BasicRoom) {
	clearTimer(room);
	const s = getState(room);
	if (!s.enabled) return;

	const timer = setTimeout(() => createAutoTournament(room), TOUR_INTERVAL);
	timers.set(room.roomid, timer);
}

function scheduleRetry(room: BasicRoom, delay: number) {
	clearTimer(room);
	const s = getState(room);
	if (!s.enabled) return;

	const timer = setTimeout(() => createAutoTournament(room), delay);
	timers.set(room.roomid, timer);
}

function clearTimer(room: BasicRoom) {
	const timer = timers.get(room.roomid);
	if (timer) {
		clearTimeout(timer);
		timers.delete(room.roomid);
	}
}

/**
 * Force-ends any tournament currently in its signup phase (not yet started).
 * Called when auto-tours are disabled mid-signup.
 */
function clearSignupTimer(room: BasicRoom) {
	const game = (room as any).game;
	if (game && typeof game.forceEnd === 'function' && !game.started) {
		try {
			game.forceEnd();
		} catch {}
	}
}

function startAutoTours(room: BasicRoom) {
	const s = getState(room);
	s.enabled = true;
	saveState(room);
	createAutoTournament(room);
}

function stopAutoTours(room: BasicRoom) {
	const s = getState(room);
	s.enabled = false;
	saveState(room);
	clearTimer(room);
	clearSignupTimer(room);
}

// On server start, restore auto-tours for rooms that had them enabled
for (const room of Rooms.rooms.values()) {
	const saved = (room.settings as any).autoTour as AutoTourState | undefined;
	if (saved?.enabled) {
		const s = getState(room);
		s.enabled = true;
		s.formatIndex = saved.formatIndex;
		setTimeout(() => {
			if (getState(room).enabled) {
				createAutoTournament(room);
			}
		}, 30 * 1000);
	}
}

/*********************************************************
 * Commands
 *********************************************************/

export const commands: Chat.ChatCommands = {
	autotour: {
		on: 'enable',
		enable(target, room, user) {
			room = this.requireRoom();
			this.checkCan('tournaments', null, room);
			const s = getState(room);
			if (s.enabled) {
				throw new Chat.ErrorMessage("Auto tournaments are already enabled in this room.");
			}
			startAutoTours(room);
			this.privateModAction(`${user.name} enabled auto tournaments.`);
			this.modlog('AUTOTOUR', null, 'ON');
			const nextFormat = getNextFormatName(room);
			const displayName = FORMAT_DISPLAY_NAMES[nextFormat] || nextFormat;
			return this.sendReply(`Auto tournaments enabled. Starting with ${displayName}. New tournaments every hour.`);
		},

		off: 'disable',
		disable(target, room, user) {
			room = this.requireRoom();
			this.checkCan('tournaments', null, room);
			const s = getState(room);
			if (!s.enabled) {
				throw new Chat.ErrorMessage("Auto tournaments are already disabled in this room.");
			}
			stopAutoTours(room);
			this.privateModAction(`${user.name} disabled auto tournaments.`);
			this.modlog('AUTOTOUR', null, 'OFF');
			return this.sendReply("Auto tournaments disabled.");
		},

		''(target, room, user) {
			return this.parse('/help autotour');
		},

		status(target, room, user) {
			room = this.requireRoom();
			this.runBroadcast();
			const s = getState(room);
			if (!s.enabled) {
				return this.sendReplyBox("Auto tournaments are currently <strong>disabled</strong>.");
			}
			const nextFormat = getNextFormatName(room);
			const displayName = FORMAT_DISPLAY_NAMES[nextFormat] || nextFormat;
			const hasTimer = timers.has(room.roomid);
			let buf = `Auto tournaments are currently <strong>enabled</strong>.<br />`;
			buf += `Next format: <strong>${Utils.escapeHTML(displayName)}</strong><br />`;
			buf += `Format rotation: ${TOUR_FORMATS.map((f, i) => {
				const dn = FORMAT_DISPLAY_NAMES[f] || f;
				return i === s.formatIndex % TOUR_FORMATS.length ? `<strong>[${Utils.escapeHTML(dn)}]</strong>` : Utils.escapeHTML(dn);
			}).join(' → ')}<br />`;
			buf += `Timer active: ${hasTimer ? 'Yes (next tour in ~1 hour)' : 'No'}`;
			return this.sendReplyBox(buf);
		},

		next(target, room, user) {
			room = this.requireRoom();
			this.checkCan('tournaments', null, room);
			const s = getState(room);
			if (!s.enabled) {
				throw new Chat.ErrorMessage("Auto tournaments are not enabled. Use /autotour on first.");
			}
			clearTimer(room);
			createAutoTournament(room);
			this.privateModAction(`${user.name} force-started the next auto tournament.`);
			this.modlog('AUTOTOUR', null, 'FORCE NEXT');
		},

		skip(target, room, user) {
			room = this.requireRoom();
			this.checkCan('tournaments', null, room);
			const s = getState(room);
			if (!s.enabled) {
				throw new Chat.ErrorMessage("Auto tournaments are not enabled. Use /autotour on first.");
			}
			const skipped = getNextFormatName(room);
			advanceFormat(room);
			const next = getNextFormatName(room);
			const skippedDisplay = FORMAT_DISPLAY_NAMES[skipped] || skipped;
			const nextDisplay = FORMAT_DISPLAY_NAMES[next] || next;
			this.privateModAction(`${user.name} skipped ${skippedDisplay}. Next format: ${nextDisplay}.`);
			this.modlog('AUTOTOUR', null, `SKIP to ${nextDisplay}`);
			return this.sendReply(`Skipped ${skippedDisplay}. Next auto tournament will be ${nextDisplay}.`);
		},
	},

	autotourhelp: [
		`/autotour on - Enable hourly auto tournaments in this room. Requires: tournaments permission`,
		`/autotour off - Disable auto tournaments. Requires: tournaments permission`,
		`/autotour status - View current auto tournament status and format rotation.`,
		`/autotour next - Force-start the next tournament immediately. Requires: tournaments permission`,
		`/autotour skip - Skip the current format and move to the next one in rotation. Requires: tournaments permission`,
		``,
		`Format rotation: RC OU → RC UU → RC VGC Reg A → RC VGC Reg B`,
		`Each tournament is Round Robin with a 15-minute registration window.`,
		`Minimum ${MIN_PLAYERS} players required. Winner earns 1 Avalugg Token.`,
	],

	avalugg: {
		''(target, room, user) {
			const tokens = getTokens(user.id);
			return this.sendReply(`❄️ You have ${tokens} Avalugg Token${tokens !== 1 ? 's' : ''}.`);
		},

		check(target, room, user) {
			const targetId = toID(target) || user.id;
			const tokens = getTokens(targetId);
			const name = target.trim() || user.name;
			this.runBroadcast();
			return this.sendReplyBox(`❄️ <strong>${Utils.escapeHTML(name)}</strong> has ${tokens} Avalugg Token${tokens !== 1 ? 's' : ''}.`);
		},

		top: 'leaderboard',
		lb: 'leaderboard',
		leaderboard(target, room, user) {
			this.runBroadcast();
			const top = getTopTokenHolders(5);
			if (!top.length) {
				return this.sendReplyBox("No Avalugg Tokens have been earned yet.");
			}
			const medals = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣'];
			let buf = `<strong>❄️ Avalugg Token Leaderboard — Top 5</strong><br /><br />`;
			for (let i = 0; i < top.length; i++) {
				const entry = top[i];
				buf += `${medals[i]} <strong>${Utils.escapeHTML(entry.userid)}</strong> — ${entry.tokens} token${entry.tokens !== 1 ? 's' : ''}<br />`;
			}
			return this.sendReplyBox(buf);
		},

		give(target, room, user) {
			room = this.requireRoom();
			this.checkCan('forcewin');
			const [targetName, amountStr] = target.split(',').map(s => s.trim());
			const targetId = toID(targetName);
			const amount = parseInt(amountStr) || 1;
			if (!targetId) return this.sendReply("Usage: /avalugg give [user], [amount]");
			if (amount < 1) return this.sendReply("Amount must be at least 1.");
			addTokens(targetId, amount);
			this.privateModAction(`${user.name} gave ${amount} Avalugg Token${amount !== 1 ? 's' : ''} to ${targetName}. (New total: ${getTokens(targetId)})`);
			this.modlog('AVALUGG GIVE', targetId, `${amount} token(s)`);
		},

		take: 'remove',
		remove(target, room, user) {
			room = this.requireRoom();
			this.checkCan('forcewin');
			const [targetName, amountStr] = target.split(',').map(s => s.trim());
			const targetId = toID(targetName);
			const amount = parseInt(amountStr) || 1;
			if (!targetId) return this.sendReply("Usage: /avalugg take [user], [amount]");
			if (amount < 1) return this.sendReply("Amount must be at least 1.");
			const current = getTokens(targetId);
			addTokens(targetId, -Math.min(amount, current));
			this.privateModAction(`${user.name} removed ${Math.min(amount, current)} Avalugg Token${amount !== 1 ? 's' : ''} from ${targetName}. (New total: ${getTokens(targetId)})`);
			this.modlog('AVALUGG TAKE', targetId, `${amount} token(s)`);
		},

		reset(target, room, user) {
			room = this.requireRoom();
			this.checkCan('forcewin');
			const targetId = toID(target);
			if (!targetId) return this.sendReply("Usage: /avalugg reset [user]");
			const old = getTokens(targetId);
			delete tokenData[targetId];
			saveTokens();
			this.privateModAction(`${user.name} reset ${target.trim()}'s Avalugg Tokens from ${old} to 0.`);
			this.modlog('AVALUGG RESET', targetId, `was ${old}`);
		},
	},

	avalugghelp: [
		`/avalugg - View your Avalugg Token count.`,
		`/avalugg check [user] - View a user's Avalugg Token count.`,
		`/avalugg top - View the top 5 Avalugg Token leaderboard.`,
		`/avalugg give [user], [amount] - Give Avalugg Tokens to a user. Requires: &`,
		`/avalugg take [user], [amount] - Remove Avalugg Tokens from a user. Requires: &`,
		`/avalugg reset [user] - Reset a user's Avalugg Tokens to 0. Requires: &`,
	],
};
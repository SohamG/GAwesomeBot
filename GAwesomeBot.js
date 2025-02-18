const process = require("process");

const { Encryption, Utils, getGuild, PostTotalData, Traffic, Trivia, Polls, Giveaways, Lotteries, GAwesomeClient, Temp: TemporaryStorage } = require("./Modules/index");
const { handler: getGuildMessageHandler } = getGuild;
const { ObjectDefines, MessageOfTheDay } = Utils;
const Timeouts = require("./Modules/Timeouts/index");
const {
	EventHandler,
	Boot,
} = require("./Internals/index");

const configJS = global.configJS = require("./Configurations/config.js");
global.configJSON = require("./Configurations/config.json");
const auth = require("./Configurations/auth.js");

const scope = { disabledEvents: ["TYPING_START"] };
Boot({ configJS, configJSON, auth }, scope).then(async () => {
	if (scope.safeMode) return;

	const database = require("./Database/Driver.js");
	const WebServer = require("./Web/WebServer");

	const privateCommandFiles = require("./Commands/Private");

	// Create a Discord.js Shard Client
	winston.silly("Creating Discord.js client.");
	const GABClient = require("./Internals/Client");
	const client = new GABClient({
		shards: parseInt(process.env.SHARDS),
		totalShardCount: parseInt(process.env.SHARD_COUNT),
		disabledEvents: scope.disabledEvents,
		messageCacheLifetime: 1800,
		messageSweepInterval: 900,
		messageCacheMaxSize: 1000,
		restTimeOffset: 50,
		debugMode: process.env.NODE_ENV !== "production",
	});

	ObjectDefines(client);

	winston.debug("Connecting to MongoDB... ~(˘▾˘~)", { URL: configJS.database.URL, db: configJS.database.db });
	await database.initialize(configJS.database).catch(err => {
		winston.error(`An error occurred while connecting to MongoDB! Is the database online? >.<\n`, err);
		process.exit(1);
	});
	winston.info("Successfully connected to MongoDB!");
	winston.debug("Initializing Discord Events.");
	client.events = new EventHandler(client, configJS);
	await client.events.init();
	client.traffic = new Traffic(client.IPC, true);
	client.central = new GAwesomeClient(client);
	client.tempStorage = new TemporaryStorage();

	client.IPC.on("getGuild", async (msg, callback) => {
		if (msg.target === "*") {
			let result = {};
			if (msg.settings.parse === "noKeys") result = [];
			let guilds = msg.settings.mutualOnlyTo ? client.guilds.filter(guild => guild.members.has(msg.settings.mutualOnlyTo)) : client.guilds;

			const query = msg.settings.findFilter;
			// eslint-disable-next-line max-len
			if (query) guilds = guilds.filter(svr => svr.name.toLowerCase().indexOf(query) > -1 || svr.id === query || (svr.members.has(svr.ownerID) && svr.members.get(svr.ownerID).user.username.toLowerCase().includes(query)));

			guilds.forEach((val, key) => {
				try {
					const res = getGuildMessageHandler(val, msg.settings, payload => payload.result);
					if (msg.settings.parse === "noKeys") result.push(res);
					else result[key] = res;
				} catch (err) {
					winston.warn(`An error occurred while fetching guild data ()-()\n`, { err: err });
				}
			});

			return callback({ target: "*", err: null, result });
		} else {
			try {
				const guild = client.guilds.get(msg.target);
				if (guild) getGuildMessageHandler(guild, msg.settings, callback);
				else return callback({ target: msg.target, err: 404, result: null });
			} catch (err) {
				winston.warn(`An error occurred while fetching guild data ()-()\n`, { err: err });
			}
		}
	});

	client.IPC.on("muteMember", async msg => {
		const guild = client.guilds.get(msg.guild);
		const channel = guild.channels.get(msg.channel);
		const member = guild.members.get(msg.member);

		await client.muteMember(channel, member);
	});

	client.IPC.on("unmuteMember", async msg => {
		const guild = client.guilds.get(msg.guild);
		const channel = guild.channels.get(msg.channel);
		const member = guild.members.get(msg.member);

		await client.unmuteMember(channel, member);
	});

	client.IPC.on("createMOTD", async msg => {
		try {
			const guild = client.guilds.get(msg.guild);
			const serverDocument = await Servers.findOne(guild.id);

			MessageOfTheDay(client, guild, serverDocument.config.message_of_the_day, serverDocument.query);
		} catch (err) {
			winston.warn("Failed to create a MOTD timer for server!", { svrid: msg.guild });
		}
	});

	client.IPC.on("postAllData", async () => {
		PostTotalData(client);
	});

	client.IPC.on("createPublicInviteLink", async msg => {
		const guildID = msg.guild;
		const guild = client.guilds.get(guildID);
		const serverDocument = await Servers.findOne(guild.id);
		const channel = guild.defaultChannel ? guild.defaultChannel : guild.channels.filter(c => c.type === "text").first();
		if (channel && serverDocument) {
			const invite = await channel.createInvite({ maxAge: 0 }, "GAwesomeBot Public Server Listing");
			serverDocument.query.set("config.public_data.server_listing.invite_link", `https://discord.gg/${invite.code}`);
			serverDocument.save();
		}
	});

	client.IPC.on("deletePublicInviteLink", async msg => {
		const guildID = msg.guild;
		const guild = client.guilds.get(guildID);
		const serverDocument = await Servers.findOne(guild.id);
		if (!serverDocument) return;
		const invites = await guild.fetchInvites();
		const invite = invites.get(serverDocument.config.public_data.server_listing.invite_link.replace("https://discord.gg/", ""));
		if (invite) invite.delete("GAwesomeBot Public Server Listing");
		serverDocument.query.set("config.public_data.server_listing.invite_link", null);
		serverDocument.save();
	});

	client.IPC.on("eval", async (msg, callback) => {
		let result = client._eval(msg);
		if (result instanceof Map) result = Array.from(result.entries());
		callback(result);
	});

	client.IPC.on("evaluate", async (msg, callback) => {
		const result = {};
		try {
			result.result = await client._eval(msg);
		} catch (err) {
			result.err = true;
			result.result = err;
		}
		if (typeof result.result !== "string") result.result = require("util").inspect(result.result, false, 1);
		callback(result);
	});

	client.IPC.on("leaveGuild", async msg => {
		const guild = client.guilds.get(msg);
		if (guild) guild.leave();
	});

	client.IPC.on("sendMessage", async msg => {
		const payload = typeof msg === "string" ? JSON.parse(msg) : msg;
		if (payload.guild === "*") {
			client.guilds.forEach(svr => {
				svr.defaultChannel.send(payload.message);
			});
		} else {
			const guild = client.guilds.get(payload.guild);
			let channel;
			if (guild) channel = guild.channels.get(payload.channel);
			if (channel) channel.send(payload.message);
		}
	});

	client.IPC.on("updateBotUser", async msg => {
		const payload = msg;
		if (payload.avatar) client.user.setAvatar(payload.avatar);
		if (payload.username && payload.username !== client.user.username) client.user.setUsername(payload.username);
		const activity = {};
		if (!payload.game || payload.game === "gawesomebot.com") activity.name = "https://gawesomebot.com | Shard {shard}".format({ shard: client.shardID });
		else activity.name = payload.game.format({ shard: client.shardID, totalShards: client.shard.count });
		activity.type = payload.type || "PLAYING";
		activity.url = payload.type === "STREAMING" ? payload.twitchURL : null;
		client.user.setPresence({
			status: payload.status || "online",
			activity: activity,
		});
	});

	client.IPC.on("traffic", async (msg, callback) => {
		winston.info("Getting traffic data");
		callback(client.traffic.get);
	});

	client.IPC.on("shardData", async (msg, callback) => {
		const data = {};
		data.isFrozen = global.isFrozen;
		if (!data.isFrozen) {
			data.users = client.users.size;
			data.guilds = client.guilds.size;
			data.ping = Math.floor(client.ws.ping);
		}
		data.rss = Math.floor((process.memoryUsage().rss / 1024) / 1024);
		data.uptime = Math.round(((process.uptime() / 60) / 60) * 10) / 10;
		data.PID = process.pid;
		data.ID = client.shardID;
		data.worker = {
			status: client.workerManager.worker.process.connected,
			PID: client.workerManager.worker.process.pid,
		};
		callback(data);
	});

	client.IPC.on("modifyActivity", async msg => {
		switch (msg.activity) {
			case "trivia": {
				const svr = client.guilds.get(msg.guild);
				const ch = client.channels.get(msg.channel);

				if (!ch) return;

				const serverDocument = await Servers.findOne({ _id: svr.id });
				if (!serverDocument) return;
				let channelDocument = serverDocument.channels[ch.id];
				if (!channelDocument) {
					serverDocument.query.prop("channels").push({ _id: ch.id });
					channelDocument = serverDocument.channels[ch.id];
				}
				await svr.populateDocument();
				if (msg.action === "end") await Trivia.end(client, svr, serverDocument, ch, channelDocument, ch);
				try {
					await serverDocument.save();
				} catch (err) {
					winston.warn(`An ${err.name} occurred while attempting to end a Trivia Game.`, { err: err, guild: svr.id });
				}
				break;
			}
			case "poll": {
				const svr = client.guilds.get(msg.guild);
				const ch = svr.channels.get(msg.channel);

				if (!ch) return;

				const serverDocument = await Servers.findOne({ _id: svr.id });
				if (!serverDocument) return;
				let channelDocument = serverDocument.channels[ch.id];
				if (!channelDocument) {
					serverDocument.query.prop("channels").push({ _id: ch.id });
					channelDocument = serverDocument.channels[ch.id];
				}
				if (msg.action === "end") await Polls.end(serverDocument, ch, channelDocument);
				try {
					await serverDocument.save();
				} catch (err) {
					winston.warn(`An ${err.name} occurred while attempting to end a Poll.`, { err: err, guild: svr.id });
				}
				break;
			}
			case "giveaway": {
				const svr = client.guilds.get(msg.guild);
				const ch = svr.channels.get(msg.channel);

				if (!ch) return;

				const serverDocument = await Servers.findOne({ _id: svr.id });
				if (!serverDocument) return;
				if (msg.action === "end") await Giveaways.end(client, svr, ch, serverDocument);
				try {
					await serverDocument.save();
				} catch (err) {
					winston.warn(`An ${err.name} occurred while attempting to end a Poll.`, { err: err, docVersion: serverDocument.__v, guild: svr.id });
				}
				break;
			}
			case "lottery": {
				const svr = client.guilds.get(msg.guild);
				const ch = client.channels.get(msg.channel);

				if (!ch) return;

				const serverDocument = await Servers.findOne({ _id: svr.id });
				if (!serverDocument) return;
				let channelDocument = serverDocument.channels[ch.id];
				if (!channelDocument) {
					serverDocument.query.prop("channels").push({ _id: ch.id });
					channelDocument = serverDocument.channels[ch.id];
				}
				if (msg.action === "end") await Lotteries.end(client, svr, serverDocument, ch, channelDocument);
				try {
					await serverDocument.save();
				} catch (err) {
					winston.warn(`A ${err.name} occurred while attempting to end a Lottery.`, { err: err, docVersion: serverDocument.__v, guild: svr.id });
				}
			}
		}
	});

	client.IPC.on("relay", async (msg, callback) => {
		const command = privateCommandFiles[msg.command];
		const main = {
			client,
			configJS,
			Constants: require("./Internals/index").Constants,
		};
		const commandData = {
			name: msg.command,
			usage: client.getPublicCommandMetadata(msg.command).usage,
			description: client.getPublicCommandMetadata(msg.command).description,
		};
		if (command) return callback(await command[msg.action](main, msg.params, commandData));
	});

	client.IPC.on("awaitMessage", async (msg, callback) => {
		const user = await client.users.fetch(msg.usr, true);
		let channel = await client.channels.get(msg.ch);
		if (!channel) channel = user.dmChannel;
		if (!channel) channel = await user.createDM();
		return callback((await client.awaitPMMessage(channel, user, msg.timeout ? msg.timeout : undefined, msg.filter ? msg.filter : undefined)).content);
	});

	client.IPC.on("updating", async (msg, callback) => {
		winston.debug("Closing Discord client & Web Interface for updater.");
		global.isUnavailable = true;
		client.destroy();
		callback();
	});

	client.IPC.on("freeze", async (msg, callback) => {
		winston.info("Freezing shard...");
		global.isFrozen = true;
		client.destroy();
		callback();
	});

	client.IPC.on("restart", async (msg, callback) => {
		const shouldReset = msg.soft;
		if (!shouldReset) {
			client.isReady = false;
			callback(); // eslint-disable-line callback-return
			client.destroy();
			// Have faith that the master will revive us
			process.exit(0);
		} else {
			client.isReady = false;
			for (const t of client._timeouts) Timeouts.clearTimeout(t);
			for (const i of client._intervals) Timeouts.clearInterval(i);
			client._timeouts.clear();
			client._intervals.clear();
			await client.events.onEvent("ready");
			client.isReady = true;
			return callback();
		}
	});

	/**
	 * CHANNEL_CREATE
	 */
	client.on("channelCreate", async channel => {
		if (client.isReady) {
			winston.silly(`Received CHANNEL_CREATE event from Discord!`, { ch: channel.id });
			try {
				await client.events.onEvent("channelCreate", channel);
			} catch (err) {
				winston.error(`An unexpected error occurred while handling a CHANNEL_CREATE event! x.x\n`, { err, svrid: channel.guild.id, chid: channel.id });
			}
		}
	});

	/**
	 * CHANNEL_DELETE
	 */
	client.on("channelDelete", async channel => {
		if (client.isReady) {
			winston.silly(`Received CHANNEL_DELETE event from Discord!`, { ch: channel.id });
			try {
				await client.events.onEvent("channelDelete", channel);
			} catch (err) {
				winston.error(`An unexpected error occurred while handling a CHANNEL_DELETE event! x.x\n`, { err, svrid: channel.guild.id, chid: channel.id });
			}
		}
	});

	/**
	 * CHANNEL_PINS_UPDATE
	 */
	client.on("channelPinsUpdate", async (channel, time) => {
		if (client.isReady) {
			winston.silly(`Received CHANNEL_PINS_UPDATE event from Discord!`, { ch: channel.id, date: time });
			try {
				await client.events.onEvent("channelPinsUpdate", channel, time);
			} catch (err) {
				winston.error(`An unexpected error occurred while handling a CHANNEL_PINS_UPDATE event! x.x\n`, { err, svrid: channel.guild.id, chid: channel.id });
			}
		}
	});

	/**
	 * CHANNEL_UPDATE
	 */
	client.on("channelUpdate", async (oldCh, newCh) => {
		if (client.isReady) {
			winston.silly(`Received CHANNEL_UPDATE event from Discord!`, { chid: newCh.id });
			try {
				await client.events.onEvent("channelUpdate", oldCh, newCh);
			} catch (err) {
				winston.error(`An unexpected error occurred while handling a CHANNEL_UPDATE event! x.x\n`, { err, svrid: newCh.guild.id, chid: newCh.id });
			}
		}
	});

	/**
	 * Internal debug event
	 */
	client.on("debug", async info => {
		if (client.isReady) winston.silly(`Received DEBUG event from Discord.js!`, { info });
	});

	/**
	 * Disconnect event
	 */
	client.on("disconnect", async event => {
		winston.silly(`Received DISCONNECT event from Discord.js!`, { code: event.code || "unknown" });
		try {
			await client.events.onEvent("disconnect", event);
		} catch (err) {
			winston.error(`An unexpected error occurred while handling a DISCONNECT event! x.x\n`, err);
		}
	});

	/**
	 * EMOJI_CREATE
	 */
	client.on("emojiCreate", async emoji => {
		if (client.isReady) {
			winston.silly(`Received EMOJI_CREATE event from Discord!`, { emoji: emoji.id });
			try {
				await client.events.onEvent("emojiCreate", emoji);
			} catch (err) {
				winston.error(`An unexpected error occurred while handling a EMOJI_CREATE event! x.x\n`, err);
			}
		}
	});

	/**
	 * EMOJI_DELETE
	 */
	client.on("emojiDelete", async emoji => {
		if (client.isReady) {
			winston.silly(`Received EMOJI_DELETE event from Discord!`, { emoji: emoji.id });
			try {
				await client.events.onEvent("emojiDelete", emoji);
			} catch (err) {
				winston.error(`An unexpected error occurred while handling a EMOJI_DELETE event! x.x\n`, err);
			}
		}
	});

	/**
	 * EMOJI_UPDATE
	 */
	client.on("emojiUpdate", async (oldEmoji, newEmoji) => {
		if (client.isReady) {
			winston.silly(`Received EMOJI_UPDATE event from Discord!`, { emoji: newEmoji.id });
			try {
				await client.events.onEvent("emojiUpdate", oldEmoji, newEmoji);
			} catch (err) {
				winston.error(`An unexpected error occurred while handling a EMOJI_UPDATE event! x.x\n`, err);
			}
		}
	});

	/**
	 * WebSocket Errors
	 */
	client.on("error", async error => {
		winston.warn(`Received ERROR event from Discord.js!`, { err: error.message });
	});

	/**
	 * GUILD_BAN_ADD
	 */
	client.on("guildBanAdd", async (guild, user) => {
		if (client.isReady) {
			winston.silly(`Received GUILD_BAN_ADD event from Discord!`, { guild: guild.id, user: user.id });
			try {
				await client.events.onEvent("guildBanAdd", guild, user);
			} catch (err) {
				winston.error(`An unexpected error occurred while handling a GUILD_BAN_ADD event! x.x\n`, { err, svrid: guild.id, usrid: user.id });
			}
		}
	});

	/**
	 * GUILD_BAN_REMOVE
	 */
	client.on("guildBanRemove", async (guild, user) => {
		if (client.isReady) {
			winston.silly(`Received GUILD_BAN_REMOVE event from Discord!`, { guild: guild.id, user: user.id });
			try {
				await client.events.onEvent("guildBanRemove", guild, user);
			} catch (err) {
				winston.error(`An unexpected error occurred while handling a GUILD_BAN_REMOVE event! x.x\n`, { err, svrid: guild.id, usrid: user.id });
			}
		}
	});

	/**
	 * GUILD_CREATE
	 */
	client.on("guildCreate", async guild => {
		if (client.isReady) {
			winston.silly(`Received GUILD_CREATE event from Discord!`, { guild: guild.id });
			try {
				await client.events.onEvent("guildCreate", guild);
			} catch (err) {
				winston.error(`An unexpected error occurred while handling a GUILD_CREATE event! x.x\n`, { err, svrid: guild.id });
			}
		}
	});

	/**
	 * GUILD_DELETE
	 */
	client.on("guildDelete", async guild => {
		if (client.isReady) {
			winston.silly(`Received GUILD_DELETE event from Discord!`, { guild: guild.id });
			try {
				await client.events.onEvent("guildDelete", guild);
			} catch (err) {
				winston.error(`An unexpected error occurred while handling a GUILD_DELETE event! x.x\n`, { err, svrid: guild.id });
			}
		}
	});

	/**
	 * GUILD_MEMBER_ADD
	 */
	client.on("guildMemberAdd", async member => {
		if (client.isReady) {
			winston.silly(`Received GUILD_MEMBER_ADD event from Discord!`, { member: member.id });
			try {
				await client.events.onEvent("guildMemberAdd", member);
			} catch (err) {
				winston.error(`An unexpected error occurred while handling a GUILD_MEMBER_ADD event! x.x\n`, { err, svrid: member.guild.id, usrid: member.id });
			}
		}
	});

	/**
	 * GUILD_MEMBER_AVAILABLE
	 * Do we need this?
	 */
	client.on("guildMemberAvailable", async member => {
		if (client.isReady) {
			winston.silly(`Received GUILD_MEMBER_AVAILABLE event from Discord!`, { member: member.id });
			try {
				await client.events.onEvent("guildMemberAvailable", member);
			} catch (err) {
				winston.error(`An unexpected error occurred while handling a GUILD_MEMBER_AVAILABLE event! x.x\n`, { err, svrid: member.guild.id, usrid: member.id });
			}
		}
	});

	/**
	 * GUILD_MEMBER_REMOVE
	 */
	client.on("guildMemberRemove", async member => {
		if (client.isReady) {
			winston.silly(`Received GUILD_MEMBER_REMOVE event from Discord!`, { member: member.id });
			try {
				await client.events.onEvent("guildMemberRemove", member);
			} catch (err) {
				winston.error(`An unexpected error occurred while handling a GUILD_MEMBER_REMOVE event! x.x\n`, { err, svrid: member.guild.id, usrid: member.id });
			}
		}
	});

	/**
	 * GUILD_MEMBERS_CHUNK
	 */
	client.on("guildMembersChunk", async (members, guild) => {
		winston.silly(`Received GUILD_MEMBERS_CHUNK event from Discord!`, { members: members.size, guild: guild.id });
		try {
			await client.events.onEvent("guildMembersChunk", members, guild);
		} catch (err) {
			winston.error(`An unexpected error occurred while handling a GUILD_MEMBERS_CHUNK event! x.x\n`, { err, svrid: guild.id });
		}
	});

	/**
	 * GUILD_MEMBER_SPEAKING
	 */
	client.on("guildMemberSpeaking", async (member, speaking) => {
		if (client.isReady) {
			winston.silly(`Received GUILD_MEMBER_SPEAKING event from Discord!`, { member: member.id, speaking });
			try {
				await client.events.onEvent("guildMemberSpeaking", member, speaking);
			} catch (err) {
				winston.error(`An unexpected error occurred while handling a GUILD_MEMBER_SPEAKING event! x.x\n`, { err, svrid: member.guild.id, usrid: member.id });
			}
		}
	});

	/**
	 * GUILD_MEMBER_UPDATE
	 */
	client.on("guildMemberUpdate", async (oldMember, newMember) => {
		if (client.isReady) {
			winston.silly(`Received GUILD_MEMBER_UPDATE event from Discord!`, { member: newMember.id });
			try {
				await client.events.onEvent("guildMemberUpdate", oldMember, newMember);
			} catch (err) {
				winston.error(`An unexpected error occurred while handling a GUILD_MEMBER_UPDATE event! x.x\n`, { err, svrid: newMember.guild.id, usrid: newMember.id });
			}
		}
	});

	/**
	 * GUILD_UNAVAILABLE
	 */
	client.on("guildUnavailable", async guild => {
		if (client.isReady) {
			winston.silly(`Received GUILD_UNAVAILABLE event from Discord!`, { guild: guild.id });
			try {
				await client.events.onEvent("guildUnavailable", guild);
			} catch (err) {
				winston.error(`An unexpected error occurred while handling a GUILD_UNAVAILABLE event! x.x\n`, { err, svrid: guild.id });
			}
		}
	});

	/**
	 * GUILD_UPDATE
	 */
	client.on("guildUpdate", async (oldGuild, newGuild) => {
		if (client.isReady) {
			winston.silly(`Received GUILD_UPDATE event from Discord!`, { guild: newGuild.id });
			try {
				await client.events.onEvent("guildUpdate", oldGuild, newGuild);
			} catch (err) {
				winston.error(`An unexpected error occurred while handling a GUILD_UPDATE event! x.x\n`, { err, svrid: newGuild.id });
			}
		}
	});

	/**
	 * MESSAGE_CREATE
	 */
	client.on("message", async msg => {
		if (client.isReady) {
			const proctime = process.hrtime();
			if (!msg.author.bot) {
				try {
					const find = await Users.findOne({ _id: msg.author.id });
					if (!find) await Users.new({ _id: msg.author.id }).save();
				} catch (err) {
					if (!/duplicate key/.test(err.message)) {
						winston.warn(`Failed to create user document for ${msg.author.tag}`, { err });
					}
				}
			}
			winston.silly("Received MESSAGE_CREATE event from Discord!", { message: msg.id });
			try {
				if (msg.guild && !msg.guild.me) await msg.guild.members.fetch(client.user);
				if (msg.guild && !msg.member && !msg.webhookID) await msg.guild.members.fetch(msg.author);
				await msg.build();
				await client.events.onEvent("message", msg, proctime);
			} catch (err) {
				winston.error(`An unexpected error occurred while handling a MESSAGE_CREATE event! x.x\n`,
					{ err, svrid: msg.guild && msg.guild.id, usrid: msg.author.id, chid: msg.channel && msg.channel.id, msgid: msg.id });
			}
		}
	});

	/**
	 * MESSAGE_DELETE
	 */
	client.on("messageDelete", async msg => {
		if (client.isReady) {
			winston.silly("Received MESSAGE_DELETE event from Discord!", { message: msg.id });
			try {
				await msg.build;
				await client.events.onEvent("messageDelete", msg);
			} catch (err) {
				winston.error(`An unexpected error occurred while handling a MESSAGE_DELETE event! x.x\n`,
					{ err, svrid: msg.guild && msg.guild.id, usrid: msg.author.id, chid: msg.channel && msg.channel.id, msgid: msg.id });
			}
		}
	});

	/**
	 * MESSAGE_DELETE_BULK
	 */
	client.on("messageDeleteBulk", async msgs => {
		if (client.isReady) {
			winston.silly("Received MESSAGE_DELETE_BULK event from Discord!", { messages: msgs.size });
			try {
				await client.events.onEvent("messageDeleteBulk", msgs);
			} catch (err) {
				winston.error(`An unexpected error occurred while handling a MESSAGE_DELETE_BULK event! x.x\n`, { err });
			}
		}
	});

	/**
	 * MESSAGE_REACTION_ADD
	 */
	client.on("messageReactionAdd", async (reaction, user) => {
		if (client.isReady) {
			winston.silly(`Received MESSAGE_REACTION_ADD event from Discord!`, { message: reaction.message.id, user: user.id });
			try {
				await client.events.onEvent("messageReactionAdd", reaction, user);
			} catch (err) {
				winston.error(`An unexpected error occurred while handling a MESSAGE_REACTION_ADD event! x.x\n`, { err });
			}
		}
	});

	/**
	 * MESSAGE_REACTION_REMOVE
	 */
	client.on("messageReactionRemove", async (reaction, user) => {
		if (client.isReady) {
			winston.silly(`Received MESSAGE_REACTION_REMOVE event from Discord!`, { message: reaction.message.id, user: user.id });
			try {
				await client.events.onEvent("messageReactionRemove", reaction, user);
			} catch (err) {
				winston.error(`An unexpected error occurred while handling a MESSAGE_REACTION_REMOVE event! x.x\n`, { err });
			}
		}
	});

	/**
	 * MESSAGE_REACTION_REMOVE_ALL
	 */
	client.on("messageReactionRemoveAll", async msg => {
		if (client.isReady) {
			winston.silly("Received MESSAGE_REACTION_REMOVE_ALL event from Discord!", { message: msg.id });
			try {
				await client.events.onEvent("messageReactionRemoveAll", msg);
			} catch (err) {
				winston.error(`An unexpected error occurred while handling a MESSAGE_REACTION_REMOVE_ALL event! x.x\n`, { err });
			}
		}
	});

	/**
	 * MESSAGE_UPDATE
	 */
	client.on("messageUpdate", async (oldMSG, newMSG) => {
		if (client.isReady) {
			winston.silly(`Received MESSAGE_UPDATE event from Discord!`, { message: newMSG.id });
			try {
				await newMSG.build();
				await oldMSG.build();
				await client.events.onEvent("messageUpdate", oldMSG, newMSG);
			} catch (err) {
				winston.error(`An unexpected error occurred while handling a MESSAGE_UPDATE event! x.x\n`, { err, svrid: newMSG.guild && newMSG.guild.id, usrid: newMSG.author.id });
			}
		}
	});

	/**
	 * PRESENCE_UPDATE
	 */
	client.on("presenceUpdate", async (oldPresence, newPresence) => {
		if (client.isReady) {
			winston.silly(`Received PRESENCE_UPDATE event from Discord!`, { member: newPresence.member.id, guild: newPresence.guild.id });
			try {
				await client.events.onEvent("presenceUpdate", oldPresence, newPresence);
			} catch (err) {
				winston.error(`An unexpected error occurred while handling a PRESENCE_UPDATE event! x.x\n`, { err, svrid: newPresence.guild.id, usrid: newPresence.member.id });
			}
		}
	});

	/**
	 * RATE_LIMIT
	 */
	client.on("rateLimit", async rateLimitInfo => {
		winston.silly(`Received RATE_LIMIT event from Discord.js!`, rateLimitInfo);
		try {
			await client.events.onEvent("rateLimit", rateLimitInfo);
		} catch (err) {
			winston.error(`An unexpected error occurred while handling a RATE_LIMIT event! x.x\n`, { err });
		}
	});

	/**
	 * READY
	 */
	client.once("ready", async () => {
		try {
			await winston.silly(`Received READY event from Discord!`);
			await client.events.onEvent("ready");
			await winston.silly("Initializing the encryption manager...");
			client.encryptionManager = new Encryption(client);
			await winston.silly("Running webserver");
			WebServer.open(client, auth, configJS, winston);
			client.isReady = true;
		} catch (err) {
			winston.error(`An unknown and unexpected error occurred with GAB, we tried our best! x.x\n`, { err });
			process.exit(1);
		}
	});

	/**
	 * RECONNECTING
	 */
	client.on("reconnecting", async () => {
		winston.silly(`Reconnecting to Discord...`);
	});

	/**
	 * RESUME
	 */
	client.on("resumed", async replayed => {
		winston.silly(`Received RESUME event from Discord!`, { replayedEvents: replayed });
		try {
			await client.events.onEvent("resumed", replayed);
		} catch (err) {
			winston.error(`An unexpected error occurred while handling a RESUME event! x.x\n`, { err });
		}
	});

	/**
	 * ROLE_CREATE
	 */
	client.on("roleCreate", async role => {
		if (client.isReady) {
			winston.silly(`Received ROLE_CREATE event from Discord!`, { role: role.id });
			try {
				await client.events.onEvent("roleCreate", role);
			} catch (err) {
				winston.error(`An unexpected error occurred while handling a ROLE_CREATE event! x.x\n`, { err, svrid: role.guild.id, roleid: role.id });
			}
		}
	});

	/**
	 * ROLE_DELETE
	 */
	client.on("roleDelete", async role => {
		if (client.isReady) {
			winston.silly(`Received ROLE_DELETE event from Discord!`, { role: role.id });
			try {
				await client.events.onEvent("roleDelete", role);
			} catch (err) {
				winston.error(`An unexpected error occurred while handling a ROLE_DELETE event! x.x\n`, { err, svrid: role.guild.id, roleid: role.id });
			}
		}
	});

	/**
	 * ROLE_UPDATE
	 */
	client.on("roleUpdate", async (oldRole, newRole) => {
		if (client.isReady) {
			winston.silly(`Received ROLE_UPDATE event from Discord!`, { role: newRole.id });
			try {
				await client.events.onEvent("roleUpdate", oldRole, newRole);
			} catch (err) {
				winston.error(`An unexpected error occurred while handling a ROLE_UPDATE event! x.x\n`, { err, svrid: newRole.guild.id, roleid: newRole.id });
			}
		}
	});

	/**
	 * USER_UPDATE
	 */
	client.on("userUpdate", async (oldUser, newUser) => {
		if (client.isReady) {
			winston.silly(`Received USER_UPDATE event from Discord!`, { user: newUser.id });
			try {
				await client.events.onEvent("userUpdate", oldUser, newUser);
			} catch (err) {
				winston.error(`An unexpected error occurred while handling a USER_UPDATE event! x.x\n`, { err, usrid: newUser.id });
			}
		}
	});

	/**
	 * VOICE_STATE_UPDATE
	 */
	client.on("voiceStateUpdate", async (oldMember, newMember) => {
		if (client.isReady) {
			winston.silly(`Received VOICE_STATE_UPDATE event from Discord!`, { member: newMember.id });
			try {
				await client.events.onEvent("voiceStateUpdate", oldMember, newMember);
			} catch (err) {
				winston.error(`An unexpected error occurred while handling a VOICE_STATE_UPDATE event! x.x\n`, { err, svrid: newMember.guild && newMember.guild.id, usrid: newMember.id });
			}
		}
	});

	/**
	 * WARN
	 */
	client.on("warn", async info => {
		winston.warn(`Received WARN event from Discord.js!`, { info });
	});

	winston.debug("Logging in to Discord Gateway.");
	try {
		await client.init();
		client.IPC.send("ready", { id: client.shard.id });
	} catch (err) {
		if (err.code === "TOKEN_INVALID") {
			winston.error(`The token you provided in auth.js could not be used to login into Discord.`);
			client.IPC.send("shutdown", { soft: false, err: true });
		} else {
			winston.error(`Failed to connect to Discord :/`);
			// eslint-disable-next-line no-console
			console.error(err);
			process.exit(1);
		}
	}

	process.on("unhandledRejection", reason => {
		winston.error(`An unexpected error occurred, and we failed to handle it. x.x\n`, reason);
	});

	process.on("uncaughtException", err => {
		winston.error(`An unexpected and unknown error occurred, and we failed to handle it. x.x\n`, err);
		process.exit(1);
	});
}).catch(err => {
	throw err;
});

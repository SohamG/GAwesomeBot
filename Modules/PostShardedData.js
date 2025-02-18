const snekfetch = require("snekfetch");
const { tokens } = require("../Configurations/auth.js");

module.exports = async client => {
	// Send server amount to DBots per shard
	if (tokens.discordBots) {
		let res;
		try {
			res = await snekfetch.post(`https://bots.discord.pw/api/bots/${client.user.id}/stats`).set({
				Accept: "application/json",
				"Content-Type": "application/json",
				Authorization: tokens.discordBots,
			}).send({
				shard_id: Number(process.env.SHARDS),
				shard_total: Number(process.env.SHARD_COUNT),
				server_count: client.guilds.size,
			});
		} catch (err) {
			winston.warn(`Failed to post to DiscordBots..\n`, err);
		}
		if (res && res.statusCode === 200) {
			winston.info(`Succesfully POSTed to bots.discord.pw`);
		} else {
			winston.warn(`Failed to POST to bots.discord.pw`, { statusCode: res.statusCode });
		}
	}
};

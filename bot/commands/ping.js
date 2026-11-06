module.exports = {
  name: 'ping',
  description: 'Check bot response time',
  async run(ctx) {
    const start = Date.now();

    const sentMsg = await ctx.sock.sendMessage(
      ctx.chatId,
      { text: 'its-phestone ⚡...' },
      { quoted: ctx.msg }
    );

    const latency = Date.now() - start;

    try {
      await ctx.sock.sendMessage(ctx.chatId, {
        text: `its-phestone ⚡${latency}ms`,
        edit: sentMsg.key
      });
    } catch (error) {
      await ctx.reply(`its-phestone ⚡${latency}ms`);
    }
  }
};

module.exports = {
  name: 'ping',
  description: 'Check bot response time',
  async run(ctx) {
    const start = Date.now();
    await ctx.reply('🏓 Pong!');
    const end = Date.now();
  }
};

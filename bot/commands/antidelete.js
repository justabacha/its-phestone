const settings = require('../core/settings');

const MODES = ['all', 'private', 'off'];

module.exports = {
  name: 'antidelete',
  description: 'Configure deleted message reporting',
  async run(ctx) {
    const [mode, ...extraArgs] = ctx.args;

    if (!mode) {
      await ctx.reply(`Anti-delete is currently set to ${settings.get('antidelete')}.`);
      return;
    }

    const selectedMode = mode.toLowerCase();
    if (extraArgs.length > 0 || !MODES.includes(selectedMode)) {
      await ctx.reply('Usage: !antidelete [all|private|off]');
      return;
    }

    settings.set('antidelete', selectedMode);
    await ctx.reply(`Anti-delete is now set to ${selectedMode}.`);
  }
};

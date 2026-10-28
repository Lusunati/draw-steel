import { requiredInteger, setOptions } from "../helpers.mjs";
import { systemID, systemPath } from "../../constants.mjs";
import AdvancementChain from "../../utils/advancement/chain.mjs";
import CreatureModel from "./creature.mjs";
import DamagePowerRollEffect from "../pseudo-documents/power-roll-effects/damage-effect.mjs";
import DamageRoll from "../../rolls/damage.mjs";
import DrawSteelChatMessage from "../../documents/chat-message.mjs";
import SourceModel from "../models/source.mjs";

/**
 * @import { DrawSteelActor, DrawSteelItem } from "../../documents/_module.mjs";
 * @import AbilityModel from "../item/ability.mjs";
 */

/**
 * A follower who adventures alongside a hero.
 */
export default class RetainerModel extends CreatureModel {
  /** @inheritdoc */
  static get metadata() {
    return {
      ...super.metadata,
      type: "retainer",
    };
  }

  /* -------------------------------------------------- */

  /** @inheritdoc */
  static LOCALIZATION_PREFIXES = super.LOCALIZATION_PREFIXES.concat([
    "DRAW_STEEL.SOURCE",
    "DRAW_STEEL.Actor.retainer",
  ]);

  /* -------------------------------------------------- */

  /** @inheritdoc */
  static defineSchema() {
    const fields = foundry.data.fields;
    const schema = super.defineSchema();

    schema.source = new fields.EmbeddedDataField(SourceModel);

    schema.retainer = new fields.SchemaField({
      freeStrike: requiredInteger({ initial: 0 }),
      keywords: new fields.SetField(setOptions()),
      role: new fields.StringField({ required: true }),
      mentor: new fields.ForeignDocumentField(foundry.documents.Actor),
    });

    schema.recoveries = new fields.SchemaField({
      value: requiredInteger(),
      max: requiredInteger({ initial: 6 }),
      bonus: requiredInteger({ persisted: false }),
      divisor: new fields.NumberField({ initial: 3, nullable: false, persisted: false }),
    });

    return schema;
  }

  /* -------------------------------------------------- */

  /** @inheritdoc */
  prepareDerivedData() {
    super.prepareDerivedData();
    this.source.prepareData();

    // allows for stamina bonuses to apply first
    this.recoveries.recoveryValue = Math.floor(this.stamina.max / this.recoveries.divisor) + this.recoveries.bonus;

    // Winded is set in the base classes derived data, so this needs to run after
    this.stamina.min = -this.stamina.winded;

    const roles = ds.CONFIG.monsters.roles;
    this.retainer.roleLabel = roles[this.retainer.role]?.label ?? "";

    const keywordFormatter = game.i18n.getListFormatter({ type: "unit" });

    const monsterKeywords = ds.CONFIG.monsters.keywords;
    const keywordList = Array.from(this.retainer.keywords).map(k => monsterKeywords[k]?.label).filter(_ => _);
    this.retainer.keywords.list = keywordList;
    this.retainer.keywords.labels = keywordFormatter.format(keywordList);
  }

  /* -------------------------------------------------- */

  /** @inheritdoc */
  async _preCreate(data, options, user) {
    const allowed = await super._preCreate(data, options, user);
    if (allowed === false) return false;

    const update = foundry.utils.mergeObject({
      prototypeToken: {
        actorLink: true,
        disposition: CONST.TOKEN_DISPOSITIONS.FRIENDLY,
        sight: {
          enabled: true,
        },
      },
    }, data, { insertKeys: false, insertValues: false });

    this.parent.updateSource(update);
  }

  /* -------------------------------------------------- */

  /**
   * Spend a recovery, adding to the retainer's stamina and reducing the number of recoveries.
   * @returns {Promise<DrawSteelActor>}
   */
  async spendRecovery() {
    if (this.recoveries.value === 0) {
      ui.notifications.error("DRAW_STEEL.Actor.base.SpendRecovery.Notifications.NoRecoveries", {
        format: { actor: this.parent.name },
      });
      return this.parent;
    }

    ui.notifications.success("DRAW_STEEL.Actor.base.SpendRecovery.Notifications.Success", {
      format: { actor: this.parent.name },
    });
    await this.parent.update({ "system.recoveries.value": this.recoveries.value - 1 });

    return this.parent.modifyTokenAttribute("stamina", this.recoveries.recoveryValue, true);
  }

  /* -------------------------------------------------- */

  /**
   * Finds the actor's current class.
   * @returns {undefined | (Omit<DrawSteelItem, "type" | "system"> & { type: "class", system: import("../item/class.mjs").default})}
   */
  get class() {
    return this.parent.itemTypes.class.at(0);
  }

  /* -------------------------------------------------- */

  /**
   * Retainers don't have subclasses.
   * @type {Set<never>}
   */
  get subclasses() {
    return new Set();
  }

  /* -------------------------------------------------- */

  /** @inheritdoc */
  get level() {
    return this.class?.system.level ?? 0;
  }

  /* -------------------------------------------------- */

  /**
   * Returns if this actor can level up.
   * @type {boolean}
   */
  get advancementReady() {
    return (this.retainer.mentor?.system.level > this.level) && this.class;
  }

  /* -------------------------------------------------- */

  /**
     * Advance a given number of levels.
     * @param {object} [options={}]                           Options to modify the advancement of levels.
     * @param {number} [options.levels=1]                     The number of levels to advance.
     * @param {foundry.documents.Item} [options.item=null]    For a hero with no current levels, a class item.
     */
  async advance({ levels = 1, item = null } = {}) {
    let cls = this.class;

    if (item && (item.type !== "class")) throw new Error("The item provided for advancing must be a class item.");
    if (!cls && !item) throw new Error("A class item is required if a retainer has no current levels.");
    if (cls && item && (item.dsid !== cls.dsid))
      throw new Error("A class item cannot be provided for advancing when a hero already has a class.");
    if (levels < 1) throw new Error("A hero cannot advance a negative number of levels.");
    if (this.level + levels > ds.CONFIG.hero.xpTrack.length) {
      throw new Error(`A hero cannot advance beyond level ${ds.CONFIG.hero.xpTrack.length}.`);
    }

    if (!cls) await item.system.applyAdvancements({ actor: this.parent });
    else {

      const chain = new AdvancementChain(this.parent, { start: this.level + 1, end: this.level + levels });

      await chain.initializeRoots();

      const configured = await ds.applications.apps.advancement.ChainConfigurationDialog.create({
        chain,
        window: {
          title: _loc("DRAW_STEEL.ADVANCEMENT.ChainConfiguration.levelUpTitle", { name: this.parent.name }),
        },
      });
      if (!configured) return;

      const toUpdate = { [cls.id]: { _id: cls.id, "system.level": chain.levelRange.end } };

      await chain.finalize({ toUpdate });
    }

    return this.class;
  }

  /* -------------------------------------------------- */

  /**
   * Fetch the traits of this creature's free strike.
   * The value is stored in `this.retainer.freeStrike`.
   * @returns {import("./_types").FreeStrike}
   */
  get freeStrike() {
    /** @type {DrawSteelItem & {system: AbilityModel}} */
    const signature = this.parent.items.documentsByType.ability.find(item => item.system.category === "signature");
    /** @type {Set<string>} */
    const keywords = new Set(["magic", "psionic", "weapon"]).intersection(signature?.system.keywords ?? new Set());

    /** @type {[DamagePowerRollEffect]} */
    const [firstDamage] = signature?.system.power.effects.documentsByType.damage ?? [];

    const freeStrike = {
      value: this.retainer.freeStrike,
      keywords: keywords.add("strike"),
      type: firstDamage?.damage.tier1.types.first() ?? "",
      range: {
        melee: 1,
        ranged: 5,
      },
    };

    if (signature && signature.system.keywords.has("strike")) freeStrike.value += (firstDamage?.damage.bonuses.value ?? 0);
    else {
      const replacementData = this.parent.getRollData();
      const field = DamagePowerRollEffect.schema.getField("damage.bonuses.value");
      for (const bonus of this._abilityBonuses) {
        if (bonus.key !== "damage.bonuses.value") continue;
        if (!bonus.filters.keywords.isSubsetOf(freeStrike.keywords)) continue;
        foundry.utils.setProperty(freeStrike, "value", field.applyChange(freeStrike.value, this, bonus, { replacementData }));
      }
    }

    switch (signature?.system.distance.type) {
      case "melee":
        freeStrike.range.melee = Math.max(1, signature.system.distance.primary ?? 0);
        break;
      case "ranged":
        freeStrike.range.ranged = Math.max(5, signature.system.distance.primary ?? 0);
        break;
      case "meleeRanged":
        freeStrike.range.melee = Math.max(1, signature.system.distance.primary ?? 0);
        freeStrike.range.ranged = Math.max(5, signature.system.distance.secondary ?? 0);
        break;
    }

    return freeStrike;
  }

  /* -------------------------------------------------- */

  /**
   * Create a chat message with the damage roll from this retainer.
   * @returns {Promise<void>}
   */
  async performFreeStrike() {
    const freeStrike = this.freeStrike;

    const title = _loc("DRAW_STEEL.Actor.npc.FreeStrike.DialogTitle");

    const roll = new DamageRoll(String(freeStrike.value), {
      type: freeStrike.type,
      flavor: ds.CONFIG.damageTypes[freeStrike.type]?.label,
    });

    await roll.evaluate();

    await DrawSteelChatMessage.create({
      title,
      speaker: DrawSteelChatMessage.getSpeaker({ actor: this.parent }),
      type: "standard",
      "system.parts": [{
        rolls: [roll],
        flavor: title,
        type: "roll",
      }],
      flags: { core: { canPopout: true } },
    });
  }
  
  /* -------------------------------------------------- */
  
  /** @inheritdoc */
  async toEmbed(config, options) {
    // All NPCs are rendered inline
    config.inline = true;

    const context = {
      actor: this.parent,
      characteristics: this._getCharacteristics(false),
      damageIW: this._getImmunitiesWeaknesses(),
      itemEmbeds: await this._getItemEmbeds(config),
      advancementEmbeds: await this._getAdvancementEmbeds(config),
      retainerKeywords: this._getRetainerKeywords().join(", "),
      movement: this._getMovement(true).list,
      system: this,
      systemFields: this.schema.fields,
    };

    const embed = document.createElement("div");

    embed.classList.add("draw-steel", "actor", "npc", "retainer", this.retainer.role || "no-role");

    embed.innerHTML = await foundry.applications.handlebars.renderTemplate(systemPath("templates/embeds/actor/retainer.hbs"), context);

    return embed;
  }

  /* -------------------------------------------------- */

  /** @inheritdoc */
  onEmbed(element) {
    element.querySelector("a[data-action='openSheet']")?.addEventListener("click", () => this.parent.sheet.render({ force: true }));
  }
  
  /* -------------------------------------------------- */

  /**
   * Fetches the printable string for the retainer's keywords.
   * @returns {string[]}
   */
  _getRetainerKeywords() {
    const retainerKeywords = ds.CONFIG.monsters.keywords;
    return Array.from(this.retainer.keywords).map(k => retainerKeywords[k]?.label).filter(_ => _);
  }

  /* -------------------------------------------------- */

  /**
   * Prepare embeds of Items for the NPC embed.
   * @param {DocumentHTMLEmbedConfig} config  Configuration for embedding behavior.
   * @returns {Promise<HTMLElement[]>}
   */
  async _getItemEmbeds(config) {
    let abilities = this._getOrderedAbilities(config);
    const { startFeatures, endFeatures } = this._getOrderedFeatures();
    const orderedItems = [...startFeatures, ...abilities, ...endFeatures];

    return Promise.all(orderedItems.map(async (item) => {
      const embed = await item.system.toEmbed({ includeName: true });
      embed.icon = item.system.getStatBlockIcon?.();
      return embed;
    }));
  }

  /* -------------------------------------------------- */
  async _getAdvancementEmbeds(config) {
    const advancements = this._getAdvancementItems();
    //Pull Advancements, get each ability who's page ref is the same as the page ref for the retainer OR Not From Monsters
    let finalPool = [];
    for (let i in advancements) {
      let pool = advancements[i].pool;
      let level = advancements[i].requirements.level;
      console.log(level);
      for (let n in pool) {
        let ability = await fromUuid(pool[n].uuid);
        console.log(ability);
        if ((ability.system.source.label === this.source.label) || (ability.system.source.book !== "Monsters")) {
          finalPool.push({ level: level, ability: ability });
        }
      }
    }
    console.log(finalPool);
    return Promise.all(finalPool.map(async (item) => {
      const embed = await item.ability.system.toEmbed({ includeName: true });
      embed.icon = item.ability.system.getStatBlockIcon?.();
      return { level: item.level, ability: embed };
    }));
  }
  /* -------------------------------------------------- */

  /**
   * Orders Ability Items in the same order
   * as the keys in ds.CONFIG.abilities.types.
   * @param {DocumentHTMLEmbedConfig} config  Configuration for embedding behavior.
   * @returns {DrawSteelItem[]}
   */
  _getOrderedAbilities(config) {
    const abilityTypes = Object.keys(ds.CONFIG.abilities.types);
    return this.parent.items.documentsByType.ability
      // Ancestry malice do not show by default
      .filter(i => config.showAll || (i.system.category !== "maliceAncestry"))
      .sort((a, b) => abilityTypes.indexOf(a.system.type) - abilityTypes.indexOf(b.system.type) || a.sort - b.sort);
  }

  /* -------------------------------------------------- */

  /**
   * Orders Feature Items via the `embedDisplay.displayAtEnd` flag.
   * @returns {{ startFeatures: DrawSteelItem[], endFeatures: DrawSteelItem[] }}
   */
  _getOrderedFeatures() {
    const features = this.parent.items.documentsByType.feature.toSorted((a, b) => a.sort - b.sort);

    const [ startFeatures, endFeatures ] = features.partition(f => {
      return !!f.getFlag(systemID, "embedDisplay.displayAtEnd");
    });
    return { startFeatures, endFeatures };
  }
  /* -------------------------------------------------- */
  /**
   * Finds the choices at 4th, 7th and 10th level.
   * @returns {String} Choices - an array of UUIDs
   */
  _getAdvancementItems() {
    const retainerClass = this.parent.items.documentsByType.class[0];
    //i => [4, 7, 10].includes(i.value.requirements.level)
    const choices = retainerClass.system.advancements.filter(i => (i.type === "itemGrant") && (i.requirements.level > this.level));
    return choices;

  }
}

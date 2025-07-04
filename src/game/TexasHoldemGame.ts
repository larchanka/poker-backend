import * as crypto from "crypto";
import { WebSocket } from "ws";
import { logger } from "../utils/logger";
import { Deck } from "./Deck";
import { HandEvaluator } from "./HandEvaluator";
import type {
  Card,
  GameState,
  HandRank,
  Player,
  ServerMessage,
} from "./interfaces";

// --- Configuration ---
const MAX_PLAYERS = 6; // Max players per table
const STARTING_CHIPS = 1000;
const SMALL_BLIND = 10;
const BIG_BLIND = 20;
const MIN_RAISE_MULTIPLIER = 1; // Raise must be at least this much higher than previous bet (e.g., previous raise amount)

export class TexasHoldemGame {
  public players: Player[] = [];
  private deck: Deck;
  private communityCards: Card[] = [];
  private pot: number = 0;
  private dealerIndex: number = -1;
  private currentPlayerIndex: number = -1;
  private gamePhase:
    | "waiting"
    | "pre-flop"
    | "flop"
    | "turn"
    | "river"
    | "showdown"
    | "hand-over" = "waiting";
  private currentBettingRound: "pre-flop" | "flop" | "turn" | "river" | null =
    null;
  private minimumBetForCall: number = 0; // The highest bet made in the current round
  private lastRaiseAmount: number = BIG_BLIND; // Tracks the size of the last raise for minimum raise rule
  private serverMessage: string = "Waiting for players to join...";
  private actionTimeout: NodeJS.Timeout | null = null; // Timer for auto-fold

  constructor() {
    this.deck = new Deck();
    logger.info("Texas Hold'em Game initialized.");
  }

  // Helper to send a message to a specific player
  private sendToPlayer(
    player: Player | { socket: WebSocket },
    type: ServerMessage["type"],
    payload: ServerMessage["payload"]
  ): void {
    if (player.socket && player.socket.readyState === WebSocket.OPEN) {
      player.socket.send(JSON.stringify({ type, payload }));
    } else {
      logger.warn(
        `Attempted to send message to closed or invalid socket for type: ${type}`
      );
    }
  }

  // Helper to broadcast game state to all players (including spectators)
  private broadcastState(message: string = this.serverMessage): void {
    this.serverMessage = message; // Update server message before broadcasting
    const publicGameState = this.getPublicGameState();
    this.players.forEach((player) => {
      if (player.isSpectator) {
        // Spectators get all hands
        const hands: Record<string, Card[]> = {};
        this.players.forEach((p) => {
          hands[p.id] = p.hand;
        });
        // Attach hands to the game state for spectators
        const spectatorState = {
          ...publicGameState,
          hands,
        };
        this.sendToPlayer(player, "state", spectatorState);
      } else {
        // Regular players get the public state only
        this.sendToPlayer(player, "state", publicGameState);
      }
    });
    logger.logGameState(publicGameState); // Log current game state for persistence (simulated)
  }

  // Get public game state (without private hands)
  private getPublicGameState(): GameState {
    // Calculate the actual minimum raise amount for the current player
    // It's the maximum of (BIG_BLIND) or (previous raise size)
    const currentMinRaise =
      this.lastRaiseAmount > 0 ? this.lastRaiseAmount : BIG_BLIND;

    return {
      players: this.players.map((p) => ({
        id: p.id,
        name: p.name,
        chips: p.chips,
        status: p.status,
        currentBet: p.currentBet,
        isDealer: p.isDealer,
        isSmallBlind: p.isSmallBlind,
        isBigBlind: p.isBigBlind,
        isSpectator: p.isSpectator,
      })),
      communityCards: this.communityCards,
      pot: this.pot,
      currentBettingRound: this.currentBettingRound,
      currentPlayerId:
        this.currentPlayerIndex !== -1
          ? this.players[this.currentPlayerIndex]?.id || null
          : null,
      gamePhase: this.gamePhase,
      message: this.serverMessage,
      minimumRaiseAmount: currentMinRaise,
      minimumBetForCall: this.minimumBetForCall, // ADDED THIS LINE
    };
  }

  // Add a new player (or spectator) to the game
  addPlayer(
    socket: WebSocket,
    name: string,
    isSpectator: boolean = false
  ): void {
    if (
      !isSpectator &&
      this.players.filter((p) => !p.isSpectator).length >= MAX_PLAYERS
    ) {
      this.sendToPlayer(
        { socket },
        "error",
        "Table is full. Cannot join as player."
      );
      logger.warn(`Attempted join by ${name} as player, but table is full.`);
      return;
    }

    const newPlayerId = crypto.randomUUID(); // Generate unique ID
    const newPlayer: Player = {
      id: newPlayerId,
      name,
      socket,
      chips: isSpectator ? 0 : STARTING_CHIPS, // Spectators have 0 chips
      hand: [],
      // If game is in progress and not a spectator, player joins as 'sitting-out'
      status:
        this.gamePhase !== "waiting" && !isSpectator
          ? "sitting-out"
          : isSpectator
          ? "spectator"
          : "active",
      currentBet: 0,
      hasActed: false,
      isDealer: false,
      isSmallBlind: false,
      isBigBlind: false,
      isSpectator: isSpectator,
    };
    this.players.push(newPlayer);
    logger.info(
      `Player '${name}' (${newPlayerId}) joined as ${
        isSpectator ? "spectator" : "player"
      }. Total players: ${this.players.length}`
    );
    if (newPlayer.status === "sitting-out") {
      this.sendToPlayer(
        newPlayer,
        "info",
        `Your ID: ${newPlayerId}. You are sitting out until the next hand.`
      );
    } else {
      this.sendToPlayer(
        newPlayer,
        "info",
        `Your ID: ${newPlayerId}. You are a ${
          isSpectator ? "spectator" : "player"
        }.`
      );
    }

    if (
      this.players.filter((p) => p.status === "active").length >= 2 &&
      this.gamePhase === "waiting"
    ) {
      this.serverMessage =
        "Minimum active players reached. Ready to start new hand.";
    }
    this.broadcastState();
  }

  // Remove a player/spectator from the game
  removePlayer(socket: WebSocket): void {
    const index = this.players.findIndex((p) => p.socket === socket);
    if (index !== -1) {
      const removedPlayer = this.players.splice(index, 1)[0];
      logger.info(
        `Player '${removedPlayer.name}' (${removedPlayer.id}) left the game.`
      );

      // If an active player leaves and causes player count to drop below 2, reset game
      if (
        this.players.filter(
          (p) =>
            !p.isSpectator &&
            p.status !== "sitting-out" &&
            p.status !== "folded"
        ).length < 2 &&
        this.gamePhase !== "waiting"
      ) {
        logger.info("Not enough active players to continue, resetting game.");
        this.resetGame();
      } else {
        this.broadcastState(
          `Player '${removedPlayer.name}' left. Waiting for more players.`
        );
      }
    }
  }

  // Start a new hand
  private startNewHand(): void {
    const players:Player[] = []
    // Reset and activate players who were sitting out and have chips
    this.players.forEach((p) => {
      if (p.isSpectator) return;
      if (p.status === "sitting-out" && p.chips > 0) {
        p.status = "active";
        logger.info(`${p.name} is now active for the new hand.`);
      } else if (p.status === "folded" && p.chips > 0) {
        p.status = "active";
        logger.info(`${p.name} remains sitting out after folding last hand.`);
      } else if (p.status === "all-in" && p.chips > 0) {
        p.status = "active";
        logger.info(`${p.name} is now active for the new hand.`);
      }
      p.hand = [];
      p.currentBet = 0;
      p.hasActed = false;
      p.isDealer = false;
      p.isSmallBlind = false;
      p.isBigBlind = false;

      players.push(p)
    });

    const activePlayers = players.filter((p) => p.status === "active" || p.status === "folded" || p.status === "all-in");
    if (activePlayers.length < 2) {
      this.serverMessage = "Need at least 2 active players to start a hand.";
      this.broadcastState();
      logger.info("Cannot start new hand: not enough active players.");
      return;
    }

    this.deck.reset();
    this.deck.shuffle();
    this.communityCards = [];
    this.pot = 0;
    this.minimumBetForCall = 0;
    this.lastRaiseAmount = BIG_BLIND; // Reset last raise for new hand

    // Rotate dealer button among active players
    const currentActivePlayers = this.players.filter(
      (p) => p.status === "active"
    );
    if (
      this.dealerIndex === -1 ||
      !currentActivePlayers.includes(this.players[this.dealerIndex])
    ) {
      this.dealerIndex = this.players.findIndex(
        (p) => p.id === currentActivePlayers[0].id
      ); // First active player
    } else {
      // Find the index of the current dealer in the filtered active players array
      let currentDealerPosInActive = currentActivePlayers.findIndex(
        (p) => p.id === this.players[this.dealerIndex].id
      );
      currentDealerPosInActive =
        (currentDealerPosInActive + 1) % currentActivePlayers.length;
      this.dealerIndex = this.players.findIndex(
        (p) => p.id === currentActivePlayers[currentDealerPosInActive].id
      );
    }
    this.players[this.dealerIndex].isDealer = true;

    // Assign blinds (SB, BB)
    let sbIndex = -1;
    let bbIndex = -1;

    // Find SB
    let tempIndex = (this.dealerIndex + 1) % this.players.length;
    let checkedCount = 0;
    while (sbIndex === -1 && checkedCount < this.players.length) {
      if (this.players[tempIndex].status === "active") {
        sbIndex = tempIndex;
      } else {
        tempIndex = (tempIndex + 1) % this.players.length;
      }
      checkedCount++;
    }
    if (sbIndex === -1) {
      logger.error(
        "Error: Could not find Small Blind. Not enough active players after dealer."
      );
      this.endHand();
      return;
    }
    this.players[sbIndex].isSmallBlind = true;

    // Find BB
    tempIndex = (sbIndex + 1) % this.players.length;
    checkedCount = 0;
    while (bbIndex === -1 && checkedCount < this.players.length) {
      if (this.players[tempIndex].status === "active") {
        bbIndex = tempIndex;
      } else {
        tempIndex = (tempIndex + 1) % this.players.length;
      }
      checkedCount++;
    }
    if (bbIndex === -1) {
      logger.error(
        "Error: Could not find Big Blind. Not enough active players after SB."
      );
      this.endHand();
      return;
    }
    this.players[bbIndex].isBigBlind = true;

    // Post blinds
    this.postBlinds(this.players[sbIndex], SMALL_BLIND);
    this.postBlinds(this.players[bbIndex], BIG_BLIND);
    this.minimumBetForCall = BIG_BLIND; // Initial bet to call is the big blind

    // Deal hole cards
    this.dealHoleCards();

    // Start pre-flop betting round
    this.gamePhase = "pre-flop";
    this.currentBettingRound = "pre-flop";
    // The first player to act pre-flop is typically the player to the left of the big blind
    this.currentPlayerIndex = (bbIndex + 1) % this.players.length;
    // Skip non-active players and spectators to find the first player to act
    checkedCount = 0;
    while (
      (this.players[this.currentPlayerIndex].status !== "active" || this.players[this.currentPlayerIndex].isSpectator) &&
      checkedCount < this.players.length
    ) {
      this.currentPlayerIndex =
        (this.currentPlayerIndex + 1) % this.players.length;
      checkedCount++;
    }
    if (this.players[this.currentPlayerIndex].status !== "active" || this.players[this.currentPlayerIndex].isSpectator) {
      logger.error(
        "Error: No active non-spectator player found after Big Blind to start pre-flop action."
      );
      this.endHand();
      return;
    }

    this.serverMessage = `New hand started. Dealer: ${
      this.players[this.dealerIndex].name
    }, SB: ${this.players[sbIndex].name}, BB: ${this.players[bbIndex].name}.`;
    this.broadcastState();
    logger.info(
      `New hand started. Dealer: ${this.players[this.dealerIndex].name}, SB: ${
        this.players[sbIndex].name
      }, BB: ${this.players[bbIndex].name}.`
    );
  }

  private postBlinds(player: Player, amount: number): void {
    const betAmount = Math.min(player.chips, amount);
    player.chips -= betAmount;
    player.currentBet += betAmount;
    this.pot += betAmount;
    logger.info(
      `${player.name} posted ${betAmount} as blind. Chips: ${player.chips}, Pot: ${this.pot}`
    );
    if (player.chips === 0 && betAmount > 0) {
      player.status = "all-in";
      logger.info(`${player.name} is now all-in.`);
    }
    // No broadcast here, as startNewHand will do a full broadcast after all blinds are posted.
  }

  // Deal two hole cards to each active player
  private dealHoleCards(): void {
    this.players
      .filter((p) => p.status === "active")
      .forEach((player) => {
        player.hand = this.deck.deal(2);
        this.sendToPlayer(player, "player_hand", player.hand);
        logger.info(
          `Dealt hole cards to ${player.name}: [${player.hand
            .map((c) => c.rank + c.suit)
            .join(", ")}]`
        );
      });
  }

  // Prompt the current player for their action
  private promptCurrentPlayerAction(): void {
    // Check if only one player remains in the hand
    const playersStillInHand = this.players.filter(
      (p) =>
        p.status !== "folded" &&
        p.status !== "sitting-out" &&
        p.status !== "spectator" &&
        p.hand.length > 0
    );
    if (playersStillInHand.length === 1) {
      this.endHandEarly();
      return;
    }
    const currentPlayer = this.players[this.currentPlayerIndex];
    // Ensure current player is active and has a hand for this round.
    if (
      !currentPlayer ||
      currentPlayer.status !== "active" ||
      currentPlayer.hand.length === 0
    ) {
      this.moveToNextPlayer(); // Skip if not active or not in current hand
      return;
    }

    // Clear any previous timer
    if (this.actionTimeout) {
      clearTimeout(this.actionTimeout);
      this.actionTimeout = null;
    }

    // Start a 30-second timer for auto-fold, but check it's still this player's turn before folding
    const playerIdAtTimeoutSet = currentPlayer.id;
    this.actionTimeout = setTimeout(() => {
      // Only auto-fold if it's still this player's turn
      logger.info(`Auto-folding player ${currentPlayer.name} (${currentPlayer.id}) due to timeout.`);
      this.handlePlayerAction(currentPlayer.id, "fold");
    }, 30000);

    const chipsToCall = this.minimumBetForCall - currentPlayer.currentBet;
    this.serverMessage = `It's ${
      currentPlayer.name
    }'s turn. Bet to call: ${chipsToCall}. You can check if ${
      chipsToCall === 0
    }. Minimum raise is ${this.minimumBetForCall + this.lastRaiseAmount}.`;
    this.broadcastState();
    logger.info(
      `Prompting ${currentPlayer.name} for action. Bet to call: ${chipsToCall}.`
    );
  }

  // Move to the next eligible player to act
  private moveToNextPlayer(): void {
    // Check if only one player remains in the hand
    const playersStillInHand = this.players.filter(
      (p) =>
        p.status !== "folded" &&
        p.status !== "sitting-out" &&
        p.status !== "spectator" &&
        p.hand.length > 0
    );
    if (playersStillInHand.length === 1) {
      this.endHandEarly();
      return;
    }
    const originalPlayerIndex = this.currentPlayerIndex;
    let nextPlayerFound = false;
    let checkedCount = 0;

    // Loop through players to find the next active, non-spectator player who hasn't acted or needs to react to a raise
    while (!nextPlayerFound && checkedCount < this.players.length) {
      this.currentPlayerIndex =
        (this.currentPlayerIndex + 1) % this.players.length;
      let nextPlayer = this.players[this.currentPlayerIndex];

      // Only active, non-spectator players who are still in the hand and haven't acted (or need to react to a raise) can act
      if (nextPlayer.status === "active" && !nextPlayer.isSpectator && nextPlayer.hand.length > 0 && nextPlayer.chips > 0) {
        if (
          nextPlayer.currentBet < this.minimumBetForCall ||
          !nextPlayer.hasActed
        ) {
          nextPlayerFound = true;
        }
      }
      checkedCount++;
      if (checkedCount >= this.players.length && !nextPlayerFound) {
        // Looped through everyone and no one needs to act
        break;
      }
    }

    if (nextPlayerFound) {
      this.promptCurrentPlayerAction();
    } else {
      // No more players need to act in this round
      this.endBettingRound();
    }
  }

  // Handle a player's action (fold, call, raise, check)
  handlePlayerAction(
    playerId: string,
    actionType: "fold" | "call" | "raise" | "check",
    amount?: number
  ): void {
    const player = this.players.find((p) => p.id === playerId);

    // Basic validation
    if (!player) {
      logger.error(`Action received for unknown player ID: ${playerId}`);
      return;
    }

    if (player.id !== this.players[this.currentPlayerIndex]?.id) {
      this.sendToPlayer(player, "error", "It is not your turn.");
      logger.warn(`${player.name} tried to act out of turn.`);
      return;
    }

    if (player.status !== "active") {
      this.sendToPlayer(
        player,
        "error",
        `You cannot act. Your status is ${player.status}.`
      );
      logger.warn(`${player.name} tried to act with status ${player.status}.`);
      return;
    }
    // Ensure player has a hand if they are taking actions
    if (player.hand.length === 0) {
      this.sendToPlayer(player, "error", "You are not currently in the hand.");
      logger.warn(
        `${player.name} tried to act but is not in the current hand.`
      );
      return;
    }

    const chipsToCall = this.minimumBetForCall - player.currentBet;
    let actionSuccessful = false;

    // Cancel the auto-fold timer if the player acts
    if (this.actionTimeout) {
      clearTimeout(this.actionTimeout);
      this.actionTimeout = null;
    }

    switch (actionType) {
      case "fold":
        player.status = "folded";
        this.serverMessage = `${player.name} folded.`;
        logger.info(this.serverMessage);
        actionSuccessful = true;
        break;

      case "check":
        if (chipsToCall > 0) {
          this.sendToPlayer(
            player,
            "error",
            `You cannot check. You must call ${chipsToCall} or raise.`
          );
          logger.warn(
            `${player.name} tried to check when chipsToCall was ${chipsToCall}.`
          );
          break;
        }
        this.serverMessage = `${player.name} checked.`;
        logger.info(this.serverMessage);
        actionSuccessful = true;
        break;

      case "call": {
        if (chipsToCall <= 0) {
          this.sendToPlayer(
            player,
            "error",
            'No valid amount to call. Please use "check" if no bet is required.'
          );
          logger.warn(
            `${player.name} tried to call when chipsToCall was ${chipsToCall}.`
          );
          break;
        }
        const chipsToBetForCall = Math.min(chipsToCall, player.chips);
        player.chips -= chipsToBetForCall;
        player.currentBet += chipsToBetForCall;
        this.pot += chipsToBetForCall;

        if (player.chips === 0) {
          player.status = "all-in";
          this.serverMessage = `${player.name} called ${chipsToBetForCall} and is all-in. Pot: ${this.pot}`;
          logger.info(
            `${player.name} called ${chipsToBetForCall} and is all-in.`
          );
        } else {
          this.serverMessage = `${player.name} called ${chipsToBetForCall}. Pot: ${this.pot}`;
          logger.info(`${player.name} called ${chipsToBetForCall}.`);
        }
        actionSuccessful = true;
        break;
      }

      case "raise": {
        // Accept both 'raise by' and 'total bet' semantics
        let totalBetAfterRaise: number;
        if (amount === undefined) {
          this.sendToPlayer(player, "error", "Raise amount required.");
          logger.warn(`${player.name} tried to raise with no amount.`);
          return;
        }
        if (amount <= player.currentBet) {
          // Treat as 'raise by' amount
          totalBetAfterRaise = player.currentBet + amount;
        } else {
          // Treat as 'total bet' amount
          totalBetAfterRaise = amount;
        }
        const actualRaiseAmount = totalBetAfterRaise - player.currentBet;
        const minimumRaiseRequired = this.minimumBetForCall + this.lastRaiseAmount;
        const isAllIn = player.chips <= actualRaiseAmount;
        if (totalBetAfterRaise < minimumRaiseRequired && !isAllIn) {
          this.sendToPlayer(
            player,
            "error",
            `Minimum raise to ${minimumRaiseRequired}.`
          );
          logger.warn(
            `${player.name} tried to raise less than minimum: ${amount}. Required: ${minimumRaiseRequired}`
          );
          break;
        }
        if (actualRaiseAmount > player.chips) {
          this.sendToPlayer(
            player,
            "error",
            "You do not have enough chips for that raise. Consider going all-in."
          );
          logger.warn(
            `${player.name} tried to raise more than chips: ${actualRaiseAmount} vs ${player.chips}.`
          );
          break;
        }
        player.chips -= actualRaiseAmount;
        player.currentBet += actualRaiseAmount;
        this.pot += actualRaiseAmount;
        this.lastRaiseAmount = actualRaiseAmount; // Update last raise amount
        this.minimumBetForCall = totalBetAfterRaise; // Update the minimum bet to call
        // Reset hasActed for all other active players (who are not all-in or folded)
        this.players
          .filter((p) => p.status === "active" && p.id !== player.id)
          .forEach((p) => (p.hasActed = false));
        if (player.chips === 0) {
          player.status = "all-in";
          this.serverMessage = `${player.name} raised to ${totalBetAfterRaise} and is all-in. Pot: ${this.pot}`;
          logger.info(
            `${player.name} raised to ${totalBetAfterRaise} and is all-in.`
          );
        } else {
          this.serverMessage = `${player.name} raised to ${totalBetAfterRaise}. Pot: ${this.pot}`;
          logger.info(`${player.name} raised to ${totalBetAfterRaise}.`);
        }
        actionSuccessful = true;
        break;
      }

      default:
        this.sendToPlayer(player, "error", "Unknown action type.");
        logger.warn(
          `Received unknown action type from ${player.name}: ${actionType}.`
        );
        break;
    }

    if (actionSuccessful) {
      player.hasActed = true; // Mark player as having acted for this turn
      this.broadcastState();
      this.checkBettingRoundEnd(); // Check if the betting round is over
    }
  }

  // Check if the current betting round has ended
  private checkBettingRoundEnd(): void {
    const activePlayersInHand = this.players.filter(
      (p) =>
        (p.status === "active" || p.status === "all-in") && p.hand.length > 0
    );

    // Rule 1: If only one active player is left (others folded/all-in), they win immediately.
    const playersStillInHand = this.players.filter(
      (p) =>
        p.status !== "folded" &&
        p.status !== "sitting-out" &&
        p.status !== "spectator" &&
        p.hand.length > 0
    );
    if (playersStillInHand.length === 1) {
      this.endHandEarly();
      return;
    }

    // Rule 2: A betting round ends when all players who are not folded/all-in/sitting-out and HAVE CARDS
    // have either checked, or matched the highest bet, AND all such players have acted.
    const needsToActPlayers = activePlayersInHand.filter(
      (p) =>
        p.status === "active" &&
        (p.currentBet < this.minimumBetForCall || !p.hasActed)
    );

    if (needsToActPlayers.length === 0) {
      // Everyone has acted and matched the highest bet or is all-in.
      logger.info(
        "Betting round ended: All active players in hand have acted and matched bets."
      );
      this.endBettingRound();
    } else {
      // Still players needing to act
      this.moveToNextPlayer();
    }
  }

  // End the current betting round and proceed to the next phase
  private endBettingRound(): void {
    // Collect all bets into the pot (already done incrementally)
    this.players.forEach((p) => (p.currentBet = 0)); // Reset individual bets for the next round
    this.minimumBetForCall = 0; // Reset for next round
    this.lastRaiseAmount = BIG_BLIND; // Reset for next round

    // Reset hasActed for all active players for the next betting round
    this.players
      .filter((p) => p.status === "active")
      .forEach((p) => (p.hasActed = false));

    switch (this.gamePhase) {
      case "pre-flop":
        this.gamePhase = "flop";
        this.currentBettingRound = "flop";
        this.dealCommunityCards(3); // Deal flop
        this.serverMessage = "Flop dealt. Starting flop betting round.";
        logger.info("Pre-flop betting ended. Dealing Flop.");
        break;
      case "flop":
        this.gamePhase = "turn";
        this.currentBettingRound = "turn";
        this.dealCommunityCards(1); // Deal turn
        this.serverMessage = "Turn dealt. Starting turn betting round.";
        logger.info("Flop betting ended. Dealing Turn.");
        break;
      case "turn":
        this.gamePhase = "river";
        this.currentBettingRound = "river";
        this.dealCommunityCards(1); // Deal river
        this.serverMessage = "River dealt. Starting river betting round.";
        logger.info("Turn betting ended. Dealing River.");
        break;
      case "river":
        this.gamePhase = "showdown";
        this.currentBettingRound = null; // Betting rounds are over
        this.serverMessage = "Showdown! Determining winner...";
        logger.info("River betting ended. Proceeding to Showdown.");
        break;
      case "showdown":
        // This case should not be reached through endBettingRound normally.
        // It means determineWinner should have been called directly.
        logger.warn(
          "endBettingRound called during Showdown phase. This might indicate a logic error."
        );
        return;
      default:
        logger.error(
          "Unexpected game phase at endBettingRound:",
          this.gamePhase
        );
        return;
    }

    // If after dealing, only one player remains in hand, they win by default
    const playersStillInHand = this.players.filter(
      (p) =>
        p.status !== "folded" &&
        p.status !== "sitting-out" &&
        p.status !== "spectator" &&
        p.hand.length > 0
    );
    if (playersStillInHand.length === 1 && this.gamePhase !== "showdown") {
      this.endHandEarly();
      return;
    }

    if (this.gamePhase === "showdown") {
      this.determineWinner(); // Proceed to showdown
    } else {
      // Start the next betting round from the first active player (who is still in hand) after the dealer (or small blind for pre-flop)
      let firstPlayerToActIndex = (this.dealerIndex + 1) % this.players.length;
      let checkedCount = 0;
      while (
        (this.players[firstPlayerToActIndex].status !== "active" ||
          this.players[firstPlayerToActIndex].hand.length === 0) &&
        checkedCount < this.players.length
      ) {
        firstPlayerToActIndex =
          (firstPlayerToActIndex + 1) % this.players.length;
        checkedCount++;
      }
      if (
        this.players[firstPlayerToActIndex].status !== "active" ||
        this.players[firstPlayerToActIndex].hand.length === 0
      ) {
        logger.error(
          "Error: No active player found to start next betting round after current dealer."
        );
        this.endHand(); // This implies no one can act, so end hand
        return;
      }
      this.currentPlayerIndex = firstPlayerToActIndex;
      this.broadcastState();
      this.promptCurrentPlayerAction();
    }
  }

  // Deal community cards
  private dealCommunityCards(count: number): void {
    const newCards = this.deck.deal(count);
    this.communityCards.push(...newCards);
    logger.info(
      `Dealt ${count} community cards: [${newCards
        .map((c) => c.rank + c.suit)
        .join(", ")}]`
    );
    this.broadcastState(); // Broadcast immediately after dealing new cards
  }

  // Determines the winner(s) at showdown using the HandEvaluator
  private determineWinner(): void {
    this.gamePhase = "showdown";
    this.serverMessage = "All cards revealed! Determining winner...";
    this.broadcastState();
    logger.info("Showdown phase initiated.");

    const playersInShowdown = this.players.filter(
      (p) =>
        p.status !== "folded" &&
        p.status !== "sitting-out" &&
        p.status !== "spectator" &&
        p.hand.length > 0
    );

    if (playersInShowdown.length === 0) {
      this.serverMessage = "No active players for showdown. Pot returned.";
      logger.warn(this.serverMessage);
      this.endHand();
      return;
    }

    // 1. Evaluate each player's best 5-card hand
    const evaluatedHands: { player: Player; handRank: HandRank }[] = [];
    playersInShowdown.forEach((player) => {
      const handRank = HandEvaluator.evaluateHand(
        player.hand,
        this.communityCards
      );
      evaluatedHands.push({ player, handRank });
      // Optionally, reveal player's hand to everyone for showdown
      this.players.forEach((p) => {
        this.sendToPlayer(
          p,
          "info",
          `${player.name}'s hand: [${player.hand
            .map((c) => c.rank + c.suit)
            .join(", ")}] Best 5-card: ${handRank.type} with [${handRank.cards
            .map((c) => c.rank + c.suit)
            .join(", ")}]`
        );
      });
      logger.info(
        `${player.name}'s evaluated hand: ${handRank.type} (Value: ${handRank.value})`
      );
    });

    // 2. Sort hands to find the winner(s) using HandEvaluator.compareHands
    evaluatedHands.sort((a, b) =>
      HandEvaluator.compareHands(b.handRank, a.handRank)
    );

    const winningHandValue = evaluatedHands[0].handRank.value;
    const winners = evaluatedHands.filter(
      (eh) =>
        HandEvaluator.compareHands(eh.handRank, evaluatedHands[0].handRank) ===
        0
    );

    if (winners.length > 0) {
      // --- SIDE POT LOGIC START ---
      // 1. Gather all players who are not spectators, sitting-out, or folded, and have a hand
      const eligiblePlayers = this.players.filter(
        (p) =>
          p.status !== "folded" &&
          p.status !== "sitting-out" &&
          p.status !== "spectator" &&
          p.hand.length > 0
      );
      // 2. Sort by total chips committed (currentBet + chips spent this hand)
      // We'll use each player's total bet for this hand (currentBet is reset at round end, so track chips spent)
      // For this implementation, we assume all-in players' max win is their total bet * number of callers
      // We'll reconstruct the bet history from player.currentBet and chips spent
      // For simplicity, we use the sum of all bets (currentBet is 0 at showdown, so we need to track per-hand bets in future for full accuracy)
      // For now, we use a simplified model: everyone can win the full pot (as before), but we note this is not full side pot logic
      // --- END SIDE POT LOGIC (placeholder, see note below) ---
      // TODO: For full side pot support, track per-hand bet history for each player
      // For now, fallback to previous logic:
      const winnerNames = winners.map((w) => w.player.name).join(" and ");
      const potShare = Math.floor(this.pot / winners.length); // Split pot evenly
      const remainder = this.pot % winners.length;
      let dealerWinnerIndex = 0;
      let minIndex = this.players.length;
      winners.forEach((w, i) => {
        const idx = this.players.findIndex((p) => p.id === w.player.id);
        if (idx !== -1 && idx < minIndex) {
          minIndex = idx;
          dealerWinnerIndex = i;
        }
      });
      winners.forEach((w, i) => {
        w.player.chips += potShare;
        if (i === dealerWinnerIndex) {
          w.player.chips += remainder;
        }
        logger.info(
          `${w.player.name} received ${potShare + (i === dealerWinnerIndex ? remainder : 0)} chips. New chips: ${w.player.chips}`
        );
      });
      this.serverMessage = `${winnerNames} win the pot of ${this.pot} chips with a ${winners[0].handRank.type}! Each gets ${potShare}${remainder ? ` (dealer gets +${remainder})` : ''}.`;
      logger.info(this.serverMessage);
    }

    setTimeout(() => this.endHand(), 5000); // End the hand after a short delay
  }

  // Ends the hand early if only one player remains (e.g., all others folded)
  private endHandEarly(): void {
    const remainingPlayers = this.players.filter(
      (p) =>
        p.status !== "folded" &&
        p.status !== "sitting-out" &&
        p.status !== "spectator" &&
        p.hand.length > 0
    );
    if (remainingPlayers.length === 1) {
      const winner = remainingPlayers[0];
      winner.chips += this.pot;
      this.serverMessage = `${winner.name} wins the pot of ${this.pot} chips by default! All others folded.`;
      logger.info(this.serverMessage);
    } else {
      // Should ideally not happen if a hand started and went to endHandEarly
      this.serverMessage =
        "No clear winner in hand. Pot returned (error state).";
      logger.error(this.serverMessage);
    }

    setTimeout(() => this.endHand(), 3000); // End hand after a short delay
  }

  // End a hand, clear state, and prepare for next hand
  private endHand(): void {
    this.gamePhase = "hand-over";
    this.currentBettingRound = null;
    this.currentPlayerIndex = -1;
    this.communityCards = [];
    this.pot = 0;
    this.minimumBetForCall = 0;
    this.lastRaiseAmount = BIG_BLIND;

    // Reset player-specific hand state and remove those out of chips
    this.players = this.players.filter((p) => {
      if (p.isSpectator) {
        p.hand = [];
        // p.status = "active";
        p.currentBet = 0;
        p.hasActed = false;
        return true; // Keep spectators
      }
      
      if (p.chips <= 0 && p.status !== "spectator") {
        p.status = "sitting-out"; // Cannot participate in next hands
        this.sendToPlayer(
          p,
          "info",
          "You are out of chips and are sitting out."
        );
        logger.info(`${p.name} is out of chips and sitting out.`);
        p.hand = [];
        p.currentBet = 0;
        p.hasActed = false;
        return true; // Keep player in list, but as sitting-out
      }
      p.hand = []; // Clear hands for active players
      p.currentBet = 0;
      p.hasActed = false;
      return true;
    });

    this.serverMessage = "Hand over. Preparing for next hand...";
    this.broadcastState();
    logger.info("Hand ended. State reset.");

    // Automatically start a new hand if enough active players
    const activePlayersCount = this.players.filter(
      (p) => p.status === "active" || p.status === "folded" || p.status === "all-in"
    ).length;
    if (activePlayersCount >= 2) {
      setTimeout(() => this.startNewHand(), 5000); // Start next hand after a delay
    } else {
      this.serverMessage =
        "Waiting for more active players to start a new hand.";
      this.broadcastState();
      logger.info("Waiting for more active players to start a new hand.");
    }
  }

  // Reset the entire game (e.g., if players leave and game cannot continue)
  private resetGame(): void {
    this.players = []; // Clear all players
    this.deck = new Deck();
    this.communityCards = [];
    this.pot = 0;
    this.dealerIndex = -1;
    this.currentPlayerIndex = -1;
    this.gamePhase = "waiting";
    this.currentBettingRound = null;
    this.minimumBetForCall = 0;
    this.lastRaiseAmount = BIG_BLIND;
    this.serverMessage = "Game reset. Waiting for players to join...";
    this.broadcastState();
    logger.info("Game fully reset due to insufficient players.");
  }

  // Check if the game can start (e.g., based on client 'ready' signals)
  checkAndStartGame(): void {
    const activePlayersCount = this.players.filter(
      (p) => p.status === "active"
    ).length;
    if (this.gamePhase === "waiting" && activePlayersCount >= 2) {
      logger.info(
        "Minimum active players reached. Starting new hand automatically..."
      );
      this.startNewHand();
    } else {
      logger.info(
        `Cannot start game yet. Current phase: ${this.gamePhase}, Active players: ${activePlayersCount}`
      );
      this.broadcastState();
    }
  }
}

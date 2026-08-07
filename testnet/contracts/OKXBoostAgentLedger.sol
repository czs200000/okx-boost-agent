// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title OKXBoostAgentLedger
/// @notice On-chain audit ledger for the OKX Boost Agent (AI market-making on X Layer).
///         The agent records every trading decision on-chain so its behavior is
///         fully verifiable: action, token, reference price and timestamp.
/// @dev Deployed on X Layer testnet for the OKX Build X "AI Season" Hackathon.
contract OKXBoostAgentLedger {
    struct Decision {
        string action; // BUY / SELL / HOLD
        string token; // symbol, e.g. NVDAx
        uint256 price; // reference price with 8 decimals
        uint256 timestamp;
    }

    address public immutable owner;
    string public agentName;
    bool public active;
    uint256 public decisionCount;
    mapping(uint256 => Decision) private decisions;

    event DecisionRecorded(uint256 indexed id, string action, string token, uint256 price, uint256 timestamp);
    event Heartbeat(uint256 timestamp);
    event AgentActive(bool active);

    modifier onlyOwner() {
        require(msg.sender == owner, "OKXBoostAgentLedger: not owner");
        _;
    }

    constructor(string memory _agentName) {
        owner = msg.sender;
        agentName = _agentName;
        active = true;
    }

    function setActive(bool _active) external onlyOwner {
        active = _active;
        emit AgentActive(_active);
    }

    /// @notice Emit a heartbeat so observers can confirm the agent is live.
    function heartbeat() external {
        emit Heartbeat(block.timestamp);
    }

    /// @notice Append a trading decision to the ledger.
    function recordDecision(string calldata action, string calldata token, uint256 price) external onlyOwner {
        decisions[decisionCount] = Decision(action, token, price, block.timestamp);
        emit DecisionRecorded(decisionCount, action, token, price, block.timestamp);
        decisionCount += 1;
    }

    function getDecision(uint256 id) external view returns (Decision memory) {
        return decisions[id];
    }
}

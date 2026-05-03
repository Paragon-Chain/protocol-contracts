// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ERC2981} from "@openzeppelin/contracts/token/common/ERC2981.sol";

/**
 * @title AgentMarket (v1 final)
 * @notice ERC-1155 template licenses priced in XPGN.
 *         MVP: buy once => isLicensed (balance > 0).
 *         Pause also blocks transfers (so licenses can't move while paused).
 */
contract AgentMarket is ERC1155, ERC2981, Ownable, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable XPGN;

    struct Template {
        address creator;
        bytes32 codeHash;
        uint256 priceXPGN;
        uint16  royaltyBps;        // for ERC2981 metadata
        uint32  allowedActions;    // future use
        bool    isActive;
    }

    mapping(uint256 => Template) public templates;
    uint256 public nextTemplateId = 1;

    address public treasury;
    uint16  public protocolFeeBps; // out of 10000

    event TemplateCreated(uint256 indexed id, address indexed creator, bytes32 codeHash, uint256 price, uint16 royaltyBps, uint32 allowedActions);
    event TemplateUpdated(uint256 indexed id, uint256 price, bool active);
    event TemplatePurchased(uint256 indexed id, address indexed buyer, uint256 qty, uint256 paid);

    constructor(address xpgn, address _treasury, uint16 _protocolFeeBps, string memory baseURI)
        ERC1155(baseURI)
        Ownable(msg.sender)
    {
        require(xpgn != address(0) && _treasury != address(0), "addr=0");
        require(_protocolFeeBps <= 2_000, "fee too high"); // <=20%
        XPGN = IERC20(xpgn);
        treasury = _treasury;
        protocolFeeBps = _protocolFeeBps;
        _setDefaultRoyalty(_treasury, 0);
    }

    // Pause should also block transfers/mints/burns
    function _update(address from, address to, uint256[] memory ids, uint256[] memory values)
        internal
        override
        whenNotPaused
    {
        super._update(from, to, ids, values);
    }

    // --------------------- Creator ---------------------

    function createTemplate(
        bytes32 codeHash,
        uint256 priceXPGN,
        uint16 royaltyBps,
        uint32 allowedActions
    ) external whenNotPaused returns (uint256 id) {
        require(royaltyBps <= 10_000, "royalty>100%");
        id = nextTemplateId++;
        templates[id] = Template({
            creator: msg.sender,
            codeHash: codeHash,
            priceXPGN: priceXPGN,
            royaltyBps: royaltyBps,
            allowedActions: allowedActions,
            isActive: true
        });
        _setTokenRoyalty(id, msg.sender, royaltyBps);
        emit TemplateCreated(id, msg.sender, codeHash, priceXPGN, royaltyBps, allowedActions);
    }

    function setTemplateActive(uint256 id, bool active) external {
        Template storage t = templates[id];
        require(t.creator == msg.sender || msg.sender == owner(), "!creator");
        t.isActive = active;
        emit TemplateUpdated(id, t.priceXPGN, active);
    }

    function setTemplatePrice(uint256 id, uint256 newPrice) external {
        Template storage t = templates[id];
        require(t.creator == msg.sender || msg.sender == owner(), "!creator");
        t.priceXPGN = newPrice;
        emit TemplateUpdated(id, newPrice, t.isActive);
    }

    // --------------------- Buyer ---------------------

    function getCost(uint256 id, uint256 qty) external view returns (uint256) {
        return templates[id].priceXPGN * qty;
    }

    function buyTemplate(uint256 id, uint256 qty) external nonReentrant whenNotPaused {
        require(qty > 0 && qty <= 1000, "qty invalid");
        Template memory t = templates[id];
        require(t.isActive, "inactive");
        uint256 cost = t.priceXPGN * qty;

        XPGN.safeTransferFrom(msg.sender, address(this), cost);

        uint256 fee = (cost * protocolFeeBps) / 10_000;
        uint256 toCreator = cost - fee;

        if (fee > 0) XPGN.safeTransfer(treasury, fee);
        if (toCreator > 0) XPGN.safeTransfer(t.creator, toCreator);

        _mint(msg.sender, id, qty, "");
        emit TemplatePurchased(id, msg.sender, qty, cost);
    }

    function isLicensed(address user, uint256 templateId) external view returns (bool) {
        return balanceOf(user, templateId) > 0;
    }

    // --------------------- Admin ---------------------

    function setTreasury(address t) external onlyOwner { require(t != address(0), "0"); treasury = t; }
    function setProtocolFeeBps(uint16 bps) external onlyOwner { require(bps <= 2_000, "fee>20%"); protocolFeeBps = bps; }
    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

    receive() external payable {}

    function sweep(address token, uint256 amount, address payable to) external onlyOwner {
        require(to != address(0), "to=0");
        if (token == address(0)) {
            (bool ok,) = to.call{value: amount}("");
            require(ok, "native sweep failed");
        } else {
            IERC20(token).safeTransfer(to, amount);
        }
    }

    // --------------------- ERC2981 / ERC165 ---------------------

    function supportsInterface(bytes4 iid) public view override(ERC1155, ERC2981) returns (bool) {
        return ERC1155.supportsInterface(iid) || ERC2981.supportsInterface(iid);
    }
}

pragma solidity 0.4.25;

/**
 * @title Synthetix interface contract
 * @notice Abstract contract to hold public getters
 * @dev pseudo interface, actually declared as contract to hold the public getters
 */
import "../interfaces/ISynthetixState.sol";
import "../interfaces/ISynth.sol";
import "../interfaces/ISynthetixEscrow.sol";
import "../interfaces/IFeePool.sol";
import "../interfaces/IExchangeRates.sol";
import "../Synth.sol";


contract ISynthetix {
    // ========== PUBLIC STATE VARIABLES ==========

    uint public totalSupply;

    mapping(bytes32 => Synth) public synths;

    // ========== PUBLIC FUNCTIONS ==========

    function balanceOf(address account) public view returns (uint);

    function transfer(address to, uint value) public returns (bool);

    function transferFrom(address from, address to, uint value) public returns (bool);

    function effectiveValue(bytes32 sourceCurrencyKey, uint sourceAmount, bytes32 destinationCurrencyKey)
        public
        view
        returns (uint);

    function exchange(bytes32 sourceCurrencyKey, uint sourceAmount, bytes32 destinationCurrencyKey) external returns (bool);

    function issueSynths(uint amount) external;

    function issueMaxSynths() external;

    function burnSynths(uint amount) external;

    function collateralisationRatio(address issuer) public view returns (uint);

    function totalIssuedSynths(bytes32 currencyKey) public view returns (uint);

    function getSynthByAddress(address synth) external view returns (bytes32);

    function debtBalanceOf(address issuer, bytes32 currencyKey) public view returns (uint);

    function remainingIssuableSynths(address issuer) public view returns (uint, uint);

    function emitSynthExchange(
        address account,
        bytes32 fromCurrencyKey,
        uint fromAmount,
        bytes32 toCurrencyKey,
        uint toAmount
    ) external;
}

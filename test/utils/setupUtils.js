const Synthetix = artifacts.require('Synthetix');
const Synth = artifacts.require('Synth');
const Exchanger = artifacts.require('Exchanger');
const FeePool = artifacts.require('FeePool');
const AddressResolver = artifacts.require('AddressResolver');

const abiDecoder = require('abi-decoder');

const { toBytes32 } = require('../../.');

module.exports = {
	/**
	 * the truffle transaction does not return all events logged, only those from the invoked
	 * contract and ERC20 Transfer events (see https://github.com/trufflesuite/truffle/issues/555),
	 * so we decode the logs with the ABIs we are using specifically and check the output
	 */
	async getDecodedLogs({ hash }) {
		// Get receipt to collect all transaction events
		const receipt = await web3.eth.getTransactionReceipt(hash);
		const synthetix = await Synthetix.deployed();
		const synthContract = await Synth.at(await synthetix.synths(toBytes32('sUSD')));

		// And required ABIs to fully decode them
		abiDecoder.addABI(synthetix.abi);
		abiDecoder.addABI(synthContract.abi);

		return abiDecoder.decodeLogs(receipt.logs);
	},

	// Assert against decoded logs
	decodedEventEqual({ event, emittedFrom, args, log, bnCloseVariance = '10' }) {
		assert.equal(log.name, event);
		assert.equal(log.address, emittedFrom);
		args.forEach((arg, i) => {
			const { type, value } = log.events[i];
			if (type === 'address') {
				assert.equal(web3.utils.toChecksumAddress(value), arg);
			} else if (/^u?int/.test(type)) {
				assert.bnClose(new web3.utils.BN(value), arg, bnCloseVariance);
			} else {
				assert.equal(value, arg);
			}
		});
	},

	async onlyGivenAddressCanInvoke({ fnc, args, address, accounts }) {
		for (const user of accounts) {
			if (user === address) {
				continue;
			}
			await assert.revert(fnc(...args, { from: user }));
		}
		await fnc(...args, { from: address });
	},

	// Helper function that can issue synths directly to a user without having to have them exchange anything
	async issueSynthsToUser({ owner, user, amount, synth }) {
		const synthetix = await Synthetix.deployed();
		const addressResolver = await AddressResolver.deployed();
		const synthContract = await Synth.at(await synthetix.synths(synth));

		// First override the resolver to make it seem the owner is the Synthetix contract
		await addressResolver.importAddresses(['Synthetix'].map(toBytes32), [owner], {
			from: owner,
		});
		await synthContract.issue(user, amount, {
			from: owner,
		});
		await addressResolver.importAddresses(['Synthetix'].map(toBytes32), [synthetix.address], {
			from: owner,
		});
	},

	async setExchangeWaitingPeriod({ owner, secs }) {
		const exchanger = await Exchanger.deployed();
		await exchanger.setWaitingPeriodSecs(secs.toString(), { from: owner });
	},

	// e.g. exchangeFeeRate = toUnit('0.005)
	async setExchangeFee({ owner, exchangeFeeRate }) {
		const feePool = await FeePool.deployed();

		await feePool.setExchangeFeeRate(exchangeFeeRate, {
			from: owner,
		});
	},
};
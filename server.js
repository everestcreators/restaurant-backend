const	express	=	require('express');
const	axios	=	require('axios');
const	db	=	require('./db');
require('dotenv').config();
const	app	=	express();
const	PORT	=	process.env.PORT	||	3000;
//	Middleware	to	parse	JSON
app.use(express.json());
//	Token	cache	for	Toast	API
let	cachedToastToken	=	null;
//	====================	HEALTH	CHECK	====================
app.get('/health',	(req,	res)	=>	{
		res.json({	
				status:	'ok',	
				message:	'Backend	server	is	running!',
				timestamp:	new	Date().toISOString()
		});
});
// ====================  AGENT LEVEL WEBHOOK ====================
app.post('/webhook/retell-events', async (req, res) => {
	console.log('📞 Retell Event received:', JSON.stringify(req.body, null, 2));
	
	const { event, call } = req.body;
	
	if (event === 'call_started') {
	  console.log('📞 Call started:', call?.call_id);
	}
	
	if (event === 'call_ended') {
	  console.log('📞 Call ended:', call?.call_id);
	}
  
	// Always return 200 so Retell knows we received it
	res.status(200).json({ received: true });
  });
//	====================	MAIN	WEBHOOK	HANDLER	====================
app.post('/webhook/retell-function',	async	(req,	res)	=>	{
		console.log('	Received	webhook	from	Retell	AI');
		console.log('Payload:',	JSON.stringify(req.body,	null,	2));
		
		const	{	call_id,	function_name,	arguments:	functionArgs	}	=	
req.body;
		
		try	{
				if	(function_name	===	'submit_order')	{
						//	Add	call_id	to	order	data
						functionArgs.call_id	=	call_id;
						
						//	Process	the	order
						console.log('	Processing	order...');
						const	result	=	await	processOrder(functionArgs);
						
						//	Return	success	response
						console.log('✅	Order	processed	successfully');
						res.json({	result:	result.message	});
						
				}	else	{
						console.log('❌	Unknown	function:',	function_name);
						res.json({	error:	'Unknown	function	name'	});
				}
				
		}	catch	(error)	{
				console.error('❌	Error	processing	order:',	error.message);
				
				//	Log	error	to	database
				await	logError(call_id,	error);
				
				//	Return	user-friendly	error
				res.json({
						error:	'Sorry,	there	was	an	issue	processing	your	order.	Let	me	transfer	you	to	our	staff.'
				});
		}
});
//	====================	PROCESS	ORDER	====================
async	function	processOrder(orderData)	{
		console.log('Step	1:	Validating	order...');
		const	validatedOrder	=	await	validateOrder(orderData);
		
		console.log('Step	2:	Sending	to	Toast	POS...');
		const	toastResponse	=	await	sendToToast(validatedOrder);
		
		console.log('Step	3:	Saving	to	database...');
		await	saveToDatabase(validatedOrder,	toastResponse);
		
		console.log('Step	4:	Building	confirmation	message...');
		const	message	=	buildConfirmationMessage(validatedOrder,	
toastResponse);
		
		return	{	message	};
}
//	====================	VALIDATE	ORDER	====================
async	function	validateOrder(orderData)	{
		console.log('Validating	items	against	menu...');
		
		//	Get	menu	items	from	database
		const	itemIds	=	orderData.items.map(item	=>	item.item_id);
		const	menuQuery	=	`
				SELECT	toast_item_id,	name,	price,	modifiers
				FROM	menu_items
				WHERE	toast_item_id	=	ANY($1::text[])
		`;
		
		const	menuResult	=	await	db.query(menuQuery,	[itemIds]);
		const	menuItems	=	menuResult.rows;
		
		console.log(`Found	${menuItems.length}	menu	items`);
		
		//	Validate	and	enrich	each	item
		const	enrichedItems	=	[];
		let	subtotal	=	0;
		
		for	(const	item	of	orderData.items)	{
				const	menuItem	=	menuItems.find(m	=>	m.toast_item_id	===	
item.item_id);
				
				if	(!menuItem)	{
						throw	new	Error(`Item	not	found	in	menu:	${item.item_id}`);
				}
				
				//	Calculate	item	total
				let	itemTotal	=	menuItem.price	*	item.quantity;
				
				//	Process	modifiers
				const	enrichedModifiers	=	[];
				if	(item.modifiers	&&	item.modifiers.length	>	0)	{
						for	(const	mod	of	item.modifiers)	{
								const	menuModifiers	=	menuItem.modifiers	||	[];
								const	menuModifier	=	menuModifiers.find(m	=>	m.id	===	
mod.modifier_id);
								
								if	(!menuModifier)	{
										console.warn(`Modifier	not	found:	${mod.modifier_id},	
skipping...`);
										continue;
								}
								
								enrichedModifiers.push({
										modifier_id:	mod.modifier_id,
										name:	menuModifier.name,
										price:	menuModifier.price,
										action:	mod.action	||	'add'
								});
								
								//	Add	modifier	price	if	action	is	'add'
								if	((mod.action	||	'add')	===	'add')	{
										itemTotal	+=	menuModifier.price	*	item.quantity;
								}
						}
				}
				
				enrichedItems.push({
						item_id:	item.item_id,
						name:	menuItem.name,
						quantity:	item.quantity,
						base_price:	menuItem.price,
						modifiers:	enrichedModifiers,
						item_total:	itemTotal
				});
				
				subtotal	+=	itemTotal;
		}
		
		//	Calculate	tax	and	total
		const	tax	=	subtotal	*	0.08;	//	8%	tax
		const	total	=	subtotal	+	tax;
		
		console.log(`Order	validated:	Subtotal	$${subtotal.toFixed(2)},	
Total	$${total.toFixed(2)}`);
		
		return	{
				...orderData,
				items:	enrichedItems,
				subtotal:	parseFloat(subtotal.toFixed(2)),
				tax:	parseFloat(tax.toFixed(2)),
				total:	parseFloat(total.toFixed(2)),
				validated:	true
		};
}
//	====================	TOAST	API	====================
async	function	getToastToken()	{
		//	Return	cached	token	if	still	valid
		if	(cachedToastToken	&&	cachedToastToken.expiresAt	>	Date.now())	{
				console.log('Using	cached	Toast	token');
				return	cachedToastToken.token;
		}
		
		console.log('Getting	new	Toast	API	token...');
		
		//	For	now,	return	environment	variable	token
		//	In	production,	implement	proper	OAuth	flow
		const	token	=	process.env.TOAST_ACCESS_TOKEN;
		
		if	(!token)	{
				throw	new	Error('Toast	API	token	not	configured');
		}
		
		return	token;
}
function	formatOrderForToast(validatedOrder)	{
		return	{
				checks:	[{
						selections:	validatedOrder.items.map(item	=>	({
								itemId:	item.item_id,
								quantity:	item.quantity,
								modifiers:	item.modifiers.map(mod	=>	({
										modifierId:	mod.modifier_id,
										quantity:	mod.action	===	'add'	?	1	:	-1
								}))
						}))
				}],
				serviceArea:	'TAKEOUT'
		};
}
async	function	sendToToast(validatedOrder)	{
		console.log('Formatting	order	for	Toast	API...');
		const	toastOrder	=	formatOrderForToast(validatedOrder);
		
		//	FOR	TESTING:	If	Toast	credentials	not	set,	simulate	response
		if	(!process.env.TOAST_ACCESS_TOKEN	||	!process.env.TOAST_RESTAURANT_GUID)	{
				console.log('⚠			Toast	API	credentials	not	configured,	simulating	response...');
				return	{
						order_id:	'test_order_'	+	Date.now(),
						pickup_time:	20,
						pickup_timestamp:	new	Date(Date.now()	+	20	*	
60000).toISOString()
				};
		}
		
		const	token	=	await	getToastToken();
		
		try	{
				console.log('Sending	order	to	Toast	POS...');
				const	response	=	await	axios.post(
						'https://ws-api.toasttab.com/orders/v2/orders',
						toastOrder,
						{
								headers:	{
										'Authorization':	`Bearer	${token}`,
										'Toast-Restaurant-External-ID':	
process.env.TOAST_RESTAURANT_GUID,
										'Content-Type':	'application/json'
								}
						}
				);
				
				console.log('✅	Order	created	in	Toast:',	response.data.guid);
				
				//	Calculate	pickup	time
				const	pickupTime	=	new	Date();
				pickupTime.setMinutes(pickupTime.getMinutes()	+	20);
				
				return	{
						order_id:	response.data.guid,
						pickup_time:	20,
						pickup_timestamp:	pickupTime.toISOString()
				};
				
		}	catch	(error)	{
				console.error('Toast	API	Error:',	error.response?.data	||	
error.message);
				throw	new	Error('Failed	to	create	order	in	Toast	POS');
		}
}
//	====================	DATABASE	====================
async	function	saveToDatabase(validatedOrder,	toastResponse)	{
		try	{
				//	Save	main	order
				const	orderId	=	await	saveOrder(validatedOrder,	toastResponse);
				
				//	Save	items
				await	saveOrderItems(orderId,	validatedOrder.items);
				
				//	Log	call
				await	logCall(validatedOrder.call_id,	{
						...validatedOrder,
						order_id:	orderId
				},	true);
				
				console.log(`✅	Order	${orderId}	saved	to	database`);
				
		}	catch	(error)	{
				console.error('Database	save	error:',	error);
				//	Don't	throw	-	order	is	already	in	Toast,	we	can	reconcile	
later
		}
}
async	function	saveOrder(orderData,	toastResponse)	{
		const	query	=	`
				INSERT	INTO	orders	(
						call_id,	toast_order_id,	customer_name,	customer_phone,
						subtotal,	tax,	total,	status,	estimated_pickup_time
				)
				VALUES	($1,	$2,	$3,	$4,	$5,	$6,	$7,	$8,	$9)
				RETURNING	id
		`;
		
		const	values	=	[
				orderData.call_id,
				toastResponse.order_id,
				orderData.customer_name,
				orderData.customer_phone	||	null,
				orderData.subtotal,
				orderData.tax,
				orderData.total,
				'confirmed',
				toastResponse.pickup_timestamp
		];
		
		const	result	=	await	db.query(query,	values);
		return	result.rows[0].id;
}
async	function	saveOrderItems(orderId,	items)	{
		for	(const	item	of	items)	{
				const	itemQuery	=	`
						INSERT	INTO	order_items	(
								order_id,	item_id,	item_name,	quantity,
								base_price,	item_total
						)
						VALUES	($1,	$2,	$3,	$4,	$5,	$6)
						RETURNING	id
				`;
				
				const	itemValues	=	[
						orderId,
						item.item_id,
						item.name,
						item.quantity,
						item.base_price,
						item.item_total
				];
				
				const	itemResult	=	await	db.query(itemQuery,	itemValues);
				const	itemId	=	itemResult.rows[0].id;
				
				//	Save	modifiers
				if	(item.modifiers	&&	item.modifiers.length	>	0)	{
						await	saveModifiers(itemId,	item.modifiers);
				}
		}
}
async	function	saveModifiers(orderItemId,	modifiers)	{
		for	(const	mod	of	modifiers)	{
				const	query	=	`
						INSERT	INTO	order_modifiers	(
								order_item_id,	modifier_id,	modifier_name,
								price,	action
						)
						VALUES	($1,	$2,	$3,	$4,	$5)
				`;
				
				const	values	=	[
						orderItemId,
						mod.modifier_id,
						mod.name,
						mod.price,
						mod.action
				];
				
				await	db.query(query,	values);
		}
}
async	function	logCall(callId,	orderData,	success,	error	=	null)	{
		const	query	=	`
				INSERT	INTO	call_logs	(
						call_sid,	retell_call_id,	from_number,
						order_id,	success,	error_message
				)
				VALUES	($1,	$2,	$3,	$4,	$5,	$6)
		`;
		
		const	values	=	[
				callId,
				orderData.call_id,
				orderData.customer_phone,
				orderData.order_id,
				success,
				error
		];
		
		try	{
				await	db.query(query,	values);
		}	catch	(err)	{
				console.error('Failed	to	log	call:',	err);
		}
}
async	function	logError(callId,	error)	{
		const	query	=	`
				INSERT	INTO	error_logs	(
						call_id,	error_type,	error_message,	stack_trace
				)
				VALUES	($1,	$2,	$3,	$4)
		`;
		
		const	values	=	[
				callId,
				error.name	||	'Error',
				error.message,
				error.stack
		];
		
		try	{
				await	db.query(query,	values);
		}	catch	(err)	{
				console.error('Failed	to	log	error:',	err);
		}
}
//	====================	RESPONSE	====================
function	buildConfirmationMessage(validatedOrder,	toastResponse)	{
		const	customerName	=	validatedOrder.customer_name	||	'there';
		const	total	=	validatedOrder.total.toFixed(2);
		const	pickupTime	=	toastResponse.pickup_time;
		
		return	`Perfect!	Your	order	is	confirmed	for	${customerName}.	`	+
									`Total	is	$${total}.	`	+
									`It'll	be	ready	in	${pickupTime}	minutes	for	pickup	at	123	
Main	Street.`;
}
//	====================	START	SERVER	====================
// Catch any unhandled errors so server doesn't crash
process.on('uncaughtException', (err) => {
	console.error('❌ Uncaught Exception:', err.message);
  });
  
  process.on('unhandledRejection', (err) => {
	console.error('❌ Unhandled Rejection:', err.message);
  });
  
app.listen(PORT,	()	=>	{
		console.log('	Backend	server	started!');
		console.log(`	Listening	on	port	${PORT}`);
		console.log(`	Webhook	URL:	
http://localhost:${PORT}/webhook/retell-function`);
		console.log(`❤			Health	check:	http://localhost:${PORT}/health`);
		console.log('');
		console.log('Waiting	for	orders...');
});


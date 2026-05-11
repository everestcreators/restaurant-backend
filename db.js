
const	{	Pool	}	=	require('pg');
require('dotenv').config();
//	Create	database	connection	pool
const	pool	=	new	Pool({
connectionString:	process.env.DATABASE_URL,
ssl:	{
rejectUnauthorized:	false
}
});
//	Test	connection
pool.query('SELECT	NOW()',	(err,	res)	=>	{
if	(err)	{
console.error('❌	Database	connection	error:',	err);
}	else	{
console.log('✅	Database	connected	at:',	res.rows[0].now);
}
});
//	Export	query	function
module.exports	=	{
query:	(text,	params)	=>	pool.query(text,	params),
pool
};

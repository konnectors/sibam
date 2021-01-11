process.env.SENTRY_DSN =
  process.env.SENTRY_DSN ||
  'https://5df2d473a7d04403bef630301165704c@sentry.cozycloud.cc/144'

const { BaseKonnector, requestFactory, log } = require('cozy-konnector-libs')
const stream = require('stream')

const request = requestFactory({
  // The debug mode shows all the details about HTTP requests and responses. Very useful for
  // debugging but very verbose. This is why it is commented out by default
  // debug: true,
  // Activates [cheerio](https://cheerio.js.org/) parsing on each page
  cheerio: false,
  // If cheerio is activated do not forget to deactivate json parsing (which is activated by
  // default in cozy-konnector-libs
  json: false,
  // This allows request-promise to keep cookies between requests
  jar: true
})

const VENDOR = 'SIBAM'
// const baseUrl = 'https://ael.sibam.fr'

module.exports = new BaseKonnector(start)

// The start function is run by the BaseKonnector instance only when it got all the account
// information (fields). When you run this connector yourself in "standalone" mode or "dev" mode,
// the account information come from ./konnector-dev-config.json file
// cozyParameters are static parameters, independents from the account. Most often, it can be a
// secret api key.
async function start(fields, cozyParameters) {
  log('info', 'Authenticating ...')
  if (cozyParameters) log('debug', 'Found COZY_PARAMETERS')
  await authenticate.bind(this)(fields.login, fields.password)
  log('info', 'Successfully logged in')
  // The BaseKonnector instance expects a Promise as return of the function
  log('info', 'Fetching the list of documents')
  const data = await request({
    method: 'POST',
    uri:
      'https://ael.sibam.fr/Portail/fr/Usager/Abonnement/AjaxFactureSynchros?EstAcompte=false',
    form: {
      sEcho: '1',
      iColumns: '11',
      sColumns: ',,,,,,,,,,',
      iDisplayStart: '0',
      iDisplayLength: '10',
      mDataProp_0: '0',
      bSortable_0: 'true',
      mDataProp_1: '1',
      bSortable_1: 'true',
      mDataProp_2: '2',
      bSortable_2: 'true',
      mDataProp_3: '3',
      bSortable_3: 'true',
      mDataProp_4: '4',
      bSortable_4: 'true',
      mDataProp_5: '5',
      bSortable_5: 'true',
      mDataProp_6: '6',
      bSortable_6: 'true',
      mDataProp_7: '7',
      bSortable_7: 'true',
      mDataProp_8: '8',
      bSortable_8: 'false',
      mDataProp_9: '9',
      bSortable_9: 'true',
      mDataProp_10: '10',
      bSortable_10: 'false',
      iSortCol_0: '1',
      sSortDir_0: 'desc',
      iSortCol_1: '9',
      sSortDir_1: 'desc',
      iSortingCols: '2'
    }
  })

  // cheerio (https://cheerio.js.org/) uses the same api as jQuery (http://jquery.com/)
  log('info', 'Parsing list of documents')
  const documents = await parseDocuments(JSON.parse(data))

  // Here we use the saveBills function even if what we fetch are not bills,
  // but this is the most common case in connectors
  log('info', 'Saving data to Cozy')
  await this.saveBills(documents, fields, {
    // This is a bank identifier which will be used to link bills to bank operations. These
    // identifiers should be at least a word found in the title of a bank operation related to this
    // bill. It is not case sensitive.
    identifiers: ['sibam'],
    contentType: 'application/pdf'
  })
}

// This shows authentication using the [signin function](https://github.com/konnectors/libs/blob/master/packages/cozy-konnector-libs/docs/api.md#module_signin)
// even if this in another domain here, but it works as an example
function authenticate(username, password) {
  return this.signin({
    url: `https://ael.sibam.fr/Portail/fr/Connexion/Login`,
    formSelector: '.main-content form',
    formData: { Login: username, MotDePasse: password },
    // The validate function will check if the login request was a success. Every website has a
    // different way to respond: HTTP status code, error message in HTML ($), HTTP redirection
    // (fullResponse.request.uri.href)...
    validate: (statusCode, $, fullResponse) => {
      // Bad: Presence of ".validation-summary-errors"
      // Good: Redirect to: "/Portail/fr/Usager/Abonnement/Factures/number"
      log('debug', fullResponse.request.uri.href)
      return (
        fullResponse.request.uri.href.indexOf(
          '/Portail/fr/Usager/Abonnement/Factures'
        ) != -1 || log('error', 'Invalid credentials')
      )
    }
  })
}

// The goal of this function is to parse a HTML page wrapped by a cheerio instance
// and return an array of JS objects which will be saved to the cozy by saveBills
// (https://github.com/konnectors/libs/blob/master/packages/cozy-konnector-libs/docs/api.md#savebills)
function parseDocuments(data) {
  // SIBAM website is strange. The bills are identified by an ID, that's listed in a table.
  // Once extracted, you must send a query with this id, and then send another query (always the same) to actually fetch the files.
  // So, it does not fit well with the saveBills method that expect a unique URL
  // Example result: {"iTotalRecords":6,"iTotalDisplayRecords":6,"sEcho":1,"aaData":[["271321424234231","06/10/2020","210.82","11.60","222.42","0.0","0.0","0.0","Réglé","26/10/2020","1","0",false,false,false,true,"1552323"]],"sMessage":null,"jQueryDataTablesModel":null}

  const lines = data.aaData.filter(
    l =>
      l[8] == 'Réglé' && parseInt(l[1].replace(/.*\/.*\/(.*)$/, '$1')) >= 2020
  )
  const monthName = [
    'Janvier',
    'Février',
    'Mars',
    'Avril',
    'Mai',
    'Juin',
    'Juillet',
    'Août',
    'Septembre',
    'Octobre',
    'Novembre',
    'Décembre'
  ]
  const docs = lines.map(function(line) {
    var date = new Date(line[1]),
      price = normalizePrice(line[4]),
      dateStr = `${
        monthName[parseInt(line[1].replace(/.*\/(.*)\/(.*)$/, '$1')) - 1]
      } ${line[1].replace(/.*\/(.*)\/(.*)$/, '$2')}`
    return {
      title: `Facture ${dateStr}`,
      date: date,
      amount: price,
      id: line[16],
      fetchFile: async function(d) {
        log('info', 'Fetching file for id: ' + d.id)
        // Prepare the store to fetch the next bill
        await request({
          method: 'POST',
          uri:
            'https://ael.sibam.fr/Portail/fr/Usager/Abonnement/StoreFactureId',
          body: { id: d.id },
          json: true
        })
        return request(
          'https://ael.sibam.fr/Portail/fr/Usager/Abonnement/TelechargerFacture'
        ).pipe(new stream.PassThrough())
      },
      currency: 'EUR',
      filename: `${dateStr.replace(/ /g, '_')}_${VENDOR}_${price.toFixed(
        2
      )}EUR.pdf`,
      vendor: VENDOR
    }
  })
  return docs
}

// Convert a price string to a float
function normalizePrice(price) {
  return parseFloat(price.replace('€', '').trim())
}
